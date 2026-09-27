import { Router } from 'express';
import type { VisionService } from './service';

export function decodeVisionRequest(body: unknown): { images: Buffer[]; imprint: string } {
  const input = body as { images?: unknown; imprint?: unknown } | null;
  if (!input || !Array.isArray(input.images) || input.images.length < 1 || input.images.length > 2) throw new Error('請提供同一種藥品的 1–2 張照片。');
  if (input.imprint !== undefined && (typeof input.imprint !== 'string' || input.imprint.length > 80)) throw new Error('刻字請限制在 80 字內。');
  const images = input.images.map(value => {
    if (typeof value !== 'string' || value.length > 11_200_000) throw new Error('單張照片上限 8 MB。');
    const match = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
    if (!match || match[2].length % 4 !== 0) throw new Error('圖片比對支援 JPEG、PNG、WebP；PDF 請改用 OCR。');
    const bytes = Buffer.from(match[2], 'base64');
    if (!bytes.length || bytes.length > 8 * 1024 * 1024) throw new Error('圖片內容無效或超過 8 MB。');
    return bytes;
  });
  if (images.reduce((n, image) => n + image.length, 0) > 12 * 1024 * 1024) throw new Error('照片合計上限 12 MB。');
  return { images, imprint: typeof input.imprint === 'string' ? input.imprint.trim() : '' };
}

type VisionApi = Pick<VisionService, 'status' | 'imagePath' | 'search'> & {
  register?: (images: Buffer[], name: string, note: string, signal: AbortSignal) => Promise<unknown>;
};
export function visionRouter(service: VisionApi, queue = { busy: false }) {
  const router = Router();
  router.get('/status', (_req, res) => res.json(service.status()));
  router.get('/images/:filename', (req, res) => {
    const match = /^([a-f0-9]{64})\.webp$/.exec(req.params.filename);
    const file = match && service.imagePath(match[1]);
    if (!file) { res.status(404).json({ error: '參考圖片不存在。' }); return; }
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.sendFile(file);
  });
  router.post(['/search', '/references'], async (req, res) => {
    const registering = req.path === '/references';
    if (registering && !service.register) { res.status(404).json({ error: '此圖片庫不支援收錄。' }); return; }
    if (registering && (req.body?.confirmed !== true || typeof req.body.productName !== 'string' || req.body.productName.trim().length < 2 || req.body.productName.length > 120 ||
      typeof req.body.sourceNote !== 'string' || !req.body.sourceNote.trim() || req.body.sourceNote.length > 300)) {
      res.status(400).json({ error: '請核對完整品名、填寫照片來源，並確認可將照片收錄至本機圖庫。' }); return;
    }
    let input: ReturnType<typeof decodeVisionRequest>;
    try { input = decodeVisionRequest(req.body); }
    catch (error) { res.status(400).json({ error: (error as Error).message }); return; }
    if (queue.busy) { res.status(429).json({ error: '本機影像模型正在處理另一筆照片，請稍後再試。' }); return; }
    const status = service.status();
    if (!registering && !status.ready) { res.status(503).json({ error: status.reason }); return; }
    queue.busy = true;
    const controller = new AbortController();
    const close = () => controller.abort();
    res.on('close', close);
    const timeout = setTimeout(() => {
      controller.abort();
      if (!res.headersSent && !res.destroyed) res.status(504).json({ error: '圖片比對逾時，請裁切照片後再試。' });
    }, 120_000);
    try {
      const result = registering ? await service.register!(input.images, req.body.productName, req.body.sourceNote, controller.signal)
        : await service.search(input.images, input.imprint, controller.signal);
      if (!controller.signal.aborted && !res.destroyed) res.json(result);
    } catch (error) {
      if (!controller.signal.aborted && !res.destroyed) res.status(422).json({ error: `圖片比對未完成：${(error as Error).message || '請重新拍攝。'}` });
    } finally { queue.busy = false; clearTimeout(timeout); res.off('close', close); }
  });
  return router;
}
