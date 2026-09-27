import express, { type ErrorRequestHandler } from 'express';
import path from 'node:path';
import { existsSync, statSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { openSessionDatabase, sessionRouter } from './sessions';
import { datasetStatus, openDrugDatabase } from './medications/store';
import { medicationRouter } from './medications/router';
import { ollamaRouter } from './ollama';
import type { RuntimeConfig } from './runtime';
import type { LocalDataSetup } from '../shared/local-data';

export async function startApplication(config: RuntimeConfig) {
  if (config.production && !existsSync(path.join(config.paths.dist, 'index.html'))) {
    throw new Error('找不到前端建置檔，請先執行 npm run build。');
  }
  const sessions = openSessionDatabase(config.paths.chatDb);
  let drugs: ReturnType<typeof openDrugDatabase> | undefined;
  let vite: Awaited<ReturnType<typeof import('vite')['createServer']>> | undefined;
  try {
    // A first visit must not create data/drugs.db and block the verified data installer.
    // Only absence permits temporary storage; inaccessible or invalid files must still fail.
    let temporary = false;
    try { statSync(config.paths.drugDb); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') temporary = true; else throw error; }
    const drugDb = drugs = openDrugDatabase(temporary ? ':memory:' : config.paths.drugDb);
    const dataSetup = (): LocalDataSetup => ({
      storage: temporary ? 'temporary' : 'persistent',
      installation: temporary && existsSync(config.paths.drugDb) ? 'restart_required' :
        config.paths.drugDb !== path.join(config.root, 'data/drugs.db') || config.paths.vision !== path.join(config.root, 'data/vision') ? 'custom_paths' :
          existsSync(path.join(config.root, 'data')) ? 'existing_directory' : 'available',
    });
    const app = express();
    const server = createHttpServer(app);
    app.use(express.json({ limit: '50mb' }));
    app.get('/api/health', (_req, res) => {
      try {
        sessions.prepare('SELECT 1').get();
        const datasets = datasetStatus(drugDb).map(({ source, count, importedAt }) => ({ source, count, importedAt }));
        const needsData = datasets.filter(item => !item.count).map(item => item.source);
        res.setHeader('Cache-Control', 'no-store');
        res.json({ status: needsData.length ? 'needs_data' : 'ready', service: 'medsafe', datasets, needsData, dataSetup: dataSetup() });
      } catch { res.status(503).json({ status: 'unavailable', error: '本機資料讀取失敗，請檢查資料庫與服務狀態。' }); }
    });
    app.use('/api/medications', medicationRouter(drugDb, undefined, undefined, dataSetup));
    app.use('/api', sessionRouter(sessions));
    app.use('/api/ai/ollama', ollamaRouter());
    app.use('/api', (_req, res) => { res.status(404).json({ error: '找不到此 API，請檢查網址或重新整理至目前版本。' }); });
    if (config.production) {
      app.use(express.static(config.paths.dist));
      app.get('*', (req, res) => {
        if (path.extname(req.path)) { res.status(404).send('找不到此檔案。'); return; }
        res.sendFile(path.join(config.paths.dist, 'index.html'));
      });
    } else {
      const { createServer } = await import('vite');
      vite = await createServer({ root: config.root, server: {
        middlewareMode: true, hmr: process.env.DISABLE_HMR === 'true' ? false : { server },
      }, appType: 'spa' });
      app.use(vite.middlewares);
    }
    const handleError: ErrorRequestHandler = (error, _req, res, next) => {
      if (res.headersSent) { next(error); return; }
      const status = error?.type === 'entity.too.large' ? 413 : error?.type === 'entity.parse.failed' ? 400 : 500;
      res.status(status).json({ error: status === 413 ? '送出的內容過大，請縮小檔案或分批處理。' : status === 400 ? '資料格式錯誤，請重新送出。' : '本機服務處理失敗，請稍後重試。' });
    };
    app.use(handleError);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(config.port, config.host, () => { server.removeListener('error', reject); resolve(); });
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('服務未取得有效連線埠。');
    let closing: Promise<void> | undefined;
    const close = () => closing ||= (async () => {
      // HMR shares this listener; release upgraded sockets before draining normal requests.
      await vite?.close();
      // Finish in-flight requests before closing their databases; bound shutdown for slow clients.
      const timer = setTimeout(() => server.closeAllConnections(), 10_000); timer.unref();
      try { await new Promise<void>(resolve => server.close(() => resolve())); }
      finally { clearTimeout(timer); drugDb.close(); sessions.close(); }
    })();
    return { port: address.port, close };
  } catch (error) { await vite?.close(); drugs?.close(); sessions.close(); throw error; }
}
