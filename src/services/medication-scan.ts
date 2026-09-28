import type { MedicationObservation } from '../../shared/medication';
import type { OcrPage, OcrTarget, ScanEngine } from '../../shared/medication-ocr';
import type { VisionResult } from '../../shared/medication-vision';
import { requestJson } from './http';

export interface ScanFile { name: string; data: string }
export interface LocalOcrOptions { target: OcrTarget; signal: AbortSignal; onProgress: (message: string) => void; imprint?: string }
export interface PhotoScanResult { vision: VisionResult | null; pages: OcrPage[]; issues: string[] }
interface PhotoScanOptions extends LocalOcrOptions { onResult?: (result: PhotoScanResult) => void }
interface Readers {
  local: (files: ScanFile[], options: LocalOcrOptions) => Promise<OcrPage[]>;
  gemini: (files: string[], apiKey: string) => Promise<MedicationObservation[]>;
  vision?: (files: ScanFile[], options: LocalOcrOptions) => Promise<VisionResult>;
  package?: (files: ScanFile[], options: LocalOcrOptions) => Promise<VisionResult>;
}
function validatePhotoFiles(files: ScanFile[]) {
  if (files.length < 1 || files.length > 2 || files.some(file => !file.data.startsWith('data:image/'))) throw new Error('圖片比對請使用同一種藥品的 1–2 張照片；PDF 請選本機 OCR。');
}
async function readVisionFiles(files: ScanFile[], options: LocalOcrOptions, kind: 'vision' | 'packages') {
  validatePhotoFiles(files);
  options.onProgress(`正在本機比對${kind === 'packages' ? '藥盒' : '藥錠'}參考圖…首次載入模型需要較久。`);
  return requestJson<VisionResult>(`/api/medications/${kind}/search`, { method: 'POST', signal: options.signal,
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ images: files.map(file => file.data), imprint: kind === 'vision' ? options.imprint || '' : '' }) });
}
const readers: Readers = {
  local: async (files, options) => (await import('./medication-ocr')).readLocalMedicationFiles(files, options),
  gemini: async (files, apiKey) => (await import('./medication-ai')).extractMedicationNames(files, apiKey),
  vision: (files, options) => readVisionFiles(files, options, 'vision'),
  package: (files, options) => readVisionFiles(files, options, 'packages'),
};

// Both local readers see the same photos, but their evidence stays separate.
// A failed index must not hide readable text; OCR never supplies an unreviewed imprint to CV.
export async function readMedicationPhoto(engine: 'vision' | 'package', files: ScanFile[], options: PhotoScanOptions, dependencies = readers): Promise<PhotoScanResult> {
  options.signal.throwIfAborted();
  validatePhotoFiles(files);
  const progress = { image: '正在比對', text: '正在準備' };
  let vision: VisionResult | null = null;
  let pages: OcrPage[] = [];
  const failures = { image: '', text: '' };
  const snapshot = (): PhotoScanResult => ({ vision, pages, issues: [failures.image, failures.text].filter(Boolean) });
  const publish = () => { if (!options.signal.aborted) options.onResult?.(snapshot()); };
  const failed = (part: keyof typeof progress, error: unknown) => {
    if (options.signal.aborted) return;
    const message = error instanceof Error ? error.message : '請稍後重試。';
    failures[part] = `${part === 'image' ? '圖片比對' : '文字讀取'}未完成：${message}`;
    update(part, '未完成'); publish();
  };
  const update = (part: keyof typeof progress, message: string) => {
    if (options.signal.aborted) return;
    progress[part] = message;
    options.onProgress(`圖片：${progress.image}；文字：${progress.text}`);
  };
  let abort = () => {};
  const stopped = new Promise<never>((_, reject) => {
    abort = () => reject(options.signal.reason || new DOMException('已取消辨識。', 'AbortError'));
    options.signal.addEventListener('abort', abort, { once: true });
  });
  try {
    const [image, text] = await Promise.race([Promise.allSettled([
      Promise.resolve().then(async () => {
        options.signal.throwIfAborted();
        const reader = dependencies[engine];
        if (!reader) throw new Error('圖片比對服務未設定。');
        const result = await reader(files, { ...options, onProgress: message => update('image', message) });
        options.signal.throwIfAborted();
        vision = result; update('image', '已完成'); publish(); return result;
      }).catch(error => { failed('image', error); throw error; }),
      Promise.resolve().then(async () => {
        options.signal.throwIfAborted();
        const result = await dependencies.local(files, { ...options, target: engine === 'vision' ? 'pill' : 'label', onProgress: message => update('text', message) });
        options.signal.throwIfAborted();
        pages = result; update('text', '已完成'); publish(); return result;
      }).catch(error => { failed('text', error); throw error; }),
    ]), stopped]);
    options.signal.throwIfAborted();
    if (image.status === 'rejected' && text.status === 'rejected') throw new Error(snapshot().issues.join(' '));
    return snapshot();
  } finally { options.signal.removeEventListener('abort', abort); }
}

// A failure stays in the selected mode; never silently upload local scans to Gemini.
export async function readMedicationScan(engine: ScanEngine, files: ScanFile[], apiKey: string, options: LocalOcrOptions, dependencies = readers): Promise<
  { engine: 'local'; pages: OcrPage[] } | { engine: 'gemini'; observations: MedicationObservation[] } | { engine: 'vision'; result: VisionResult } | { engine: 'package'; result: VisionResult }
> {
  options.signal.throwIfAborted();
  if (engine === 'vision' && dependencies.vision) return { engine, result: await dependencies.vision(files, options) };
  if (engine === 'package' && dependencies.package) return { engine, result: await dependencies.package(files, options) };
  if (engine === 'local') return { engine, pages: await dependencies.local(files, options) };
  if (engine === 'gemini') return { engine, observations: await dependencies.gemini(files.map(file => file.data), apiKey) };
  throw new Error('辨識模式無效');
}
