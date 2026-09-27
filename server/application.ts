import express, { type ErrorRequestHandler } from 'express';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { openSessionDatabase, sessionRouter } from './sessions';
import { datasetStatus, openDrugDatabase } from './medications/store';
import { medicationRouter } from './medications/router';
import { ollamaRouter } from './ollama';
import type { RuntimeConfig } from './runtime';

export async function startApplication(config: RuntimeConfig) {
  if (config.production && !existsSync(path.join(config.paths.dist, 'index.html'))) {
    throw new Error('找不到前端建置檔，請先執行 npm run build。');
  }
  const sessions = openSessionDatabase(config.paths.chatDb);
  let drugs: ReturnType<typeof openDrugDatabase> | undefined;
  let vite: Awaited<ReturnType<typeof import('vite')['createServer']>> | undefined;
  try {
    const drugDb = drugs = openDrugDatabase(config.paths.drugDb);
    const app = express();
    app.use(express.json({ limit: '50mb' }));
    app.get('/api/health', (_req, res) => {
      try {
        sessions.prepare('SELECT 1').get();
        const datasets = datasetStatus(drugDb).map(({ source, count, importedAt }) => ({ source, count, importedAt }));
        const needsData = datasets.filter(item => !item.count).map(item => item.source);
        res.json({ status: needsData.length ? 'needs_data' : 'ready', service: 'medsafe', datasets, needsData });
      } catch { res.status(503).json({ status: 'unavailable', error: '本機資料讀取失敗，請檢查資料庫與服務狀態。' }); }
    });
    app.use('/api/medications', medicationRouter(drugDb));
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
      vite = await createServer({ root: config.root, server: { middlewareMode: true }, appType: 'spa' });
      app.use(vite.middlewares);
    }
    const handleError: ErrorRequestHandler = (error, _req, res, next) => {
      if (res.headersSent) { next(error); return; }
      const status = error?.type === 'entity.too.large' ? 413 : error?.type === 'entity.parse.failed' ? 400 : 500;
      res.status(status).json({ error: status === 413 ? '送出的內容過大，請縮小檔案或分批處理。' : status === 400 ? '資料格式錯誤，請重新送出。' : '本機服務處理失敗，請稍後重試。' });
    };
    app.use(handleError);
    const server = await new Promise<ReturnType<typeof app.listen>>((resolve, reject) => {
      const listener = app.listen(config.port, config.host, () => resolve(listener));
      listener.once('error', reject);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('服務未取得有效連線埠。');
    let closing: Promise<void> | undefined;
    const close = () => closing ||= (async () => {
      // Finish in-flight requests before closing their databases; bound shutdown for slow clients.
      const timer = setTimeout(() => server.closeAllConnections(), 10_000); timer.unref();
      try { await new Promise<void>(resolve => server.close(() => resolve())); }
      finally { clearTimeout(timer); await vite?.close(); drugDb.close(); sessions.close(); }
    })();
    return { port: address.port, close };
  } catch (error) { await vite?.close(); drugs?.close(); sessions.close(); throw error; }
}
