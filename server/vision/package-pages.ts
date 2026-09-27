import { createRequire } from 'node:module';
import path from 'node:path';
import sharp from 'sharp';

// Official "outer box image" links may be multi-page PDF artwork. Render every
// bounded page locally, retaining page identity instead of silently using page 1.
export async function packagePages(bytes: Buffer, signal: AbortSignal): Promise<Buffer[]> {
  signal.throwIfAborted();
  const webp = (input: Buffer) => sharp(input, { limitInputPixels: 24_000_000, animated: false }).rotate().flatten({ background: '#fff' })
    .resize(1600, 1600, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 92 }).toBuffer();
  if (bytes.subarray(0, 5).toString() !== '%PDF-') {
    const metadata = await sharp(bytes, { limitInputPixels: 24_000_000, animated: false }).metadata();
    if (!['jpeg', 'png', 'webp'].includes(metadata.format || '') || (metadata.pages || 1) !== 1 || Math.min(metadata.width || 0, metadata.height || 0) < 32)
      throw new Error('官方連結不是支援的圖片或 PDF，請開啟原始來源查看。');
    return [await webp(bytes)];
  }
  const [{ getDocument }, { createCanvas }] = await Promise.all([import('pdfjs-dist/legacy/build/pdf.mjs'), import('@napi-rs/canvas')]);
  const require = createRequire(import.meta.url), root = path.dirname(require.resolve('pdfjs-dist/package.json'));
  const loading = getDocument({ data: Uint8Array.from(bytes), isEvalSupported: false, useSystemFonts: false, enableXfa: false,
    stopAtErrors: true, maxImageSize: 24_000_000, verbosity: 0,
    standardFontDataUrl: path.join(root, 'standard_fonts').replaceAll('\\', '/') + '/',
    cMapUrl: path.join(root, 'cmaps').replaceAll('\\', '/') + '/', cMapPacked: true });
  const abort = () => { void loading.destroy().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    signal.throwIfAborted();
    const pdf = await loading.promise;
    if (!pdf.numPages || pdf.numPages > 8) throw new Error('外盒 PDF 超過 8 頁，未部分收錄，請先開啟來源核對。');
    const images: Buffer[] = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      signal.throwIfAborted(); const page = await pdf.getPage(i), original = page.getViewport({ scale: 1 });
      const scale = 1600 / Math.max(original.width, original.height), viewport = page.getViewport({ scale });
      if (!Number.isFinite(scale) || scale <= 0 || Math.min(viewport.width, viewport.height) < 32) throw new Error('外盒 PDF 頁面尺寸無效');
      const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
      const rendering = page.render({ canvas: canvas as never, canvasContext: canvas.getContext('2d') as never, viewport });
      const cancel = () => rendering.cancel(); signal.addEventListener('abort', cancel, { once: true });
      try { await rendering.promise; signal.throwIfAborted(); images.push(await webp(canvas.toBuffer('image/png'))); }
      finally { signal.removeEventListener('abort', cancel); page.cleanup(); }
    }
    return images;
  } finally { signal.removeEventListener('abort', abort); await loading.destroy(); }
}
