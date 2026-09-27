import { Router } from 'express';
import type { OfficialPackageReferences } from './official-packages';

export function officialPackageRouter(store: OfficialPackageReferences, queue = { busy: false }) {
  const router = Router();
  router.get('/official-references', (req, res) => {
    if (typeof req.query.drugId !== 'string' || !req.query.drugId || req.query.drugId.length > 80) { res.status(400).json({ error: '請提供藥品許可證。' }); return; }
    res.setHeader('Cache-Control', 'private, no-store'); res.json(store.snapshot(req.query.drugId).library);
  });
  router.get('/official-images/:filename', (req, res) => {
    const match = /^([a-f0-9]{64})\.webp$/.exec(req.params.filename), file = match && store.imagePath(match[1]);
    if (!file) { res.status(404).json({ error: '外盒圖已失效或缺失。' }); return; }
    res.setHeader('Cache-Control', 'private, no-store'); res.setHeader('X-Content-Type-Options', 'nosniff'); res.sendFile(file);
  });
  router.post('/official-references/:key/disable', (req, res) => {
    try { store.disable(req.params.key); res.json({ success: true }); }
    catch (error) { res.status(422).json({ error: (error as Error).message }); }
  });
  router.post('/official-references/:key/enable', (req, res) => {
    if (req.body?.confirmed !== true) { res.status(400).json({ error: '請先放大核對本頁的品名、規格及許可證。' }); return; }
    if (queue.busy) { res.status(429).json({ error: '本機正在處理照片，請稍後再試。' }); return; }
    try { store.enable(req.params.key); res.json({ success: true }); }
    catch (error) { res.status(422).json({ error: (error as Error).message }); }
  });
  router.post('/official-references', async (req, res) => {
    const body = req.body;
    if (typeof body?.drugId !== 'string' || !body.drugId || body.drugId.length > 80 || typeof body.sourceUrl !== 'string' || body.sourceUrl.length > 2000 ||
        typeof body.indexSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(body.indexSha256)) {
      res.status(400).json({ error: '請從已確認藥品的官方外盒清單選擇圖片。' }); return;
    }
    if (queue.busy) { res.status(429).json({ error: '本機正在處理照片，請稍後再試。' }); return; }
    queue.busy = true;
    const controller = new AbortController(), close = () => controller.abort(); res.on('close', close);
    const timer = setTimeout(() => {
      controller.abort();
      if (!res.headersSent && !res.destroyed) res.status(504).json({ error: '保存外盒圖逾時，請重試；已完成的相同圖片不會重複下載。' });
    }, 120_000);
    try {
      const result = await store.save(body.drugId, body.sourceUrl, body.indexSha256, controller.signal);
      if (!controller.signal.aborted && !res.destroyed) res.json({ ...result, library: store.snapshot(body.drugId).library });
    } catch (error) {
      if (!controller.signal.aborted && !res.destroyed) res.status(422).json({ error: `未完成保存：${(error as Error).message}` });
    } finally { clearTimeout(timer); res.off('close', close); queue.busy = false; }
  });
  return router;
}
