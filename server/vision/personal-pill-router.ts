import { Router } from 'express';
import { decodeVisionRequest } from './router';
import type { PersonalPillReferences } from './personal-pills';
import type { VisionService } from './service';

export function personalPillRouter(store: PersonalPillReferences, vision: VisionService, queue = { busy: false }) {
  const router = Router();
  router.get('/personal-references', (_req, res) => {
    res.setHeader('Cache-Control', 'private, no-store'); res.json(store.snapshot().library);
  });
  router.get('/personal-images/:filename', (req, res) => {
    const match = /^([a-f0-9]{64})\.webp$/.exec(req.params.filename);
    const file = match && store.imagePath(match[1]);
    if (!file) { res.status(404).json({ error: '照片已停用、缺失或需要重新核對。' }); return; }
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff'); res.sendFile(file);
  });
  router.post('/personal-references/:key/disable', (req, res) => {
    try { store.disable(req.params.key); res.json({ library: store.snapshot().library, status: vision.status() }); }
    catch (error) { res.status(422).json({ error: (error as Error).message }); }
  });
  router.post('/personal-references', async (req, res) => {
    const body = req.body;
    if (body?.confirmed !== true || typeof body.drugId !== 'string' || !body.drugId || body.drugId.length > 80 ||
      typeof body.identity !== 'string' || body.identity.length > 20_000 || typeof body.sourceNote !== 'string' || !body.sourceNote.trim() || body.sourceNote.length > 300) {
      res.status(400).json({ error: '請選擇已核對品項、填寫照片來源，並確認照片與許可證相符後收錄。' }); return;
    }
    let input: ReturnType<typeof decodeVisionRequest>;
    try { input = decodeVisionRequest(body); }
    catch (error) { res.status(400).json({ error: (error as Error).message }); return; }
    if (queue.busy) { res.status(429).json({ error: '本機正在處理照片，請稍後再試。' }); return; }
    queue.busy = true;
    const controller = new AbortController(), close = () => controller.abort();
    res.on('close', close);
    const timer = setTimeout(() => {
      controller.abort();
      if (!res.headersSent && !res.destroyed) res.status(504).json({ error: '收錄逾時，請重新檢查圖庫；相同照片可重送。' });
    }, 120_000);
    try {
      await store.register(input.images, body.drugId, body.identity, body.sourceNote, controller.signal);
      if (!controller.signal.aborted && !res.destroyed) res.json({ library: store.snapshot().library, status: vision.status() });
    } catch (error) {
      if (!controller.signal.aborted && !res.destroyed) res.status(422).json({ error: `未完成收錄：${(error as Error).message}` });
    } finally { queue.busy = false; clearTimeout(timer); res.off('close', close); }
  });
  return router;
}
