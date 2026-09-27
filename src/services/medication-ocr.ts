import { createWorker, OEM, PSM, type Worker } from 'tesseract.js';
import type { PDFDocumentLoadingTask } from 'pdfjs-dist';
import { ocrImageSize, withEnlargedReading, type OcrPage, type OcrReading, type OcrRegion } from '../../shared/medication-ocr';
import { filePart, MAX_FILE_BYTES, MAX_TOTAL_BYTES } from './medication-files';
import type { ScanFile, LocalOcrOptions } from './medication-scan';

const MAX_PAGES = 10;
const MAX_SIDE = 2400;

function canvasFor(width: number, height: number, scale = 1) {
  if (!width || !height || !Number.isFinite(width + height)) throw new Error('圖片尺寸無效，請重新拍攝。');
  const ratio = Math.min(scale, MAX_SIDE / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * ratio)); canvas.height = Math.max(1, Math.round(height * ratio));
  const context = canvas.getContext('2d');
  if (!context) throw new Error('瀏覽器無法處理圖片，請改用手動輸入。');
  context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height);
  return { canvas, context, ratio };
}

export async function readLocalMedicationFiles(files: ScanFile[], { target, signal, onProgress }: LocalOcrOptions): Promise<OcrPage[]> {
  signal.throwIfAborted();
  if (!files.length || files.length > 4) throw new Error('請選擇 1–4 個檔案。');
  const sources = files.map(file => ({ ...file, ...filePart(file.data).inlineData }));
  const sizes = sources.map(file => { const base64 = file.data.replace(/[\r\n]/g, ''); return Math.floor(base64.length * 3 / 4) - (base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0); });
  if (sizes.some(size => size > MAX_FILE_BYTES) || sizes.reduce((a, b) => a + b, 0) > MAX_TOTAL_BYTES) throw new Error('單檔上限 8 MB，全部合計上限 12 MB。');
  let worker: Worker | undefined;
  let labelReader: ReturnType<typeof import('./label-ocr').createLabelReader> | undefined;
  let pdfTask: PDFDocumentLoadingTask | undefined;
  let stopReason: Error | undefined;
  let rejectStop: (reason: Error) => void = () => {};
  const stopped = new Promise<never>((_, reject) => { rejectStop = reject; });
  // Attach a handler before any asynchronous setup can fail or be cancelled.
  void stopped.catch(() => {});
  const stop = (reason: Error) => {
    stopReason ||= reason; rejectStop(stopReason);
    void worker?.terminate(); void pdfTask?.destroy();
    labelReader?.terminate();
  };
  const abort = () => stop(new DOMException('已取消本機辨識。', 'AbortError'));
  signal.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(() => stop(new Error('本機 OCR 處理逾時，請縮小照片範圍或減少 PDF 頁數後重試。')), 180_000);
  const wait = <T,>(promise: Promise<T>) => Promise.race([promise, stopped]);
  const pages: OcrPage[] = [];
  let progressLabel = '準備本機 OCR';
  try {
    onProgress('正在載入本機 OCR 引擎與語言模型…');
    const base = new URL(`${import.meta.env.BASE_URL}ocr/`, window.location.href).href;
    async function textWorker() {
      if (worker) return worker;
      const starting = createWorker(['chi_tra', 'eng'], OEM.LSTM_ONLY, {
        workerPath: `${base}worker.min.js`, corePath: `${base}core`, langPath: `${base}lang`,
        workerBlobURL: false, cachePath: 'medsafe-ocr-v1',
        logger: message => { if (!stopReason) onProgress(`${progressLabel} · ${Math.round(message.progress * 100)}%`); },
        errorHandler: () => stop(new Error('本機 OCR 引擎或模型載入失敗，請重新整理後重試，或手動輸入藥名。')),
      });
      starting.then(ready => { if (stopReason) void ready.terminate(); }, () => {});
      worker = await wait(starting);
      await wait(worker.setParameters({ tessedit_pageseg_mode: PSM.SPARSE_TEXT, preserve_interword_spaces: '1', user_defined_dpi: '300' }));
      return worker;
    }
    async function recognize(canvas: HTMLCanvasElement, fileName: string, page: number, photo = false, enlarged?: HTMLCanvasElement) {
      if (pages.length >= MAX_PAGES) throw new Error(`每次最多辨識 ${MAX_PAGES} 頁，請分批上傳；本次結果未送出。`);
      progressLabel = `${fileName} · 第 ${page} 頁`;
      onProgress(`${progressLabel} · 正在讀取文字…`);
      try {
        let data: { text: string; confidence: number; regions?: OcrRegion[] };
        if (photo) {
          onProgress(`${progressLabel} · 正在本機讀取${target === 'pill' ? '藥錠刻字' : '包裝文字'}，首次載入需要較久…`);
          if (!labelReader) labelReader = (await wait(import('./label-ocr'))).createLabelReader(base);
          data = await wait(labelReader.recognize(canvas));
        } else {
          data = (await wait((await textWorker()).recognize(canvas))).data;
        }
        let preview: string | undefined;
        const reading = (result: typeof data): OcrReading => {
          if (result.text.length > 10000) throw new Error('此頁文字過多，請裁切藥名區域後重試。');
          const text = result.text.trim();
          if (result.regions?.length) preview ??= canvas.toDataURL('image/jpeg', 0.9);
          return { text, confidence: result.confidence,
            ...(result.regions?.length ? { layout: { text, regions: result.regions, image: preview! } } : {}) };
        };
        let result: OcrPage = { fileName, page, ...reading(data) };
        if (enlarged) {
          onProgress(`${progressLabel} · 正在補讀照片中的小字…`);
          try { result = withEnlargedReading(result, reading(await wait(labelReader!.recognize(enlarged)))); }
          catch (error) {
            if (stopReason || signal.aborted) throw error;
            result.readNotice = '小字補讀未完成，已保留原尺寸結果；可裁切照片後重新辨識。';
          }
        }
        pages.push(result);
      } finally { canvas.width = 0; canvas.height = 0; if (enlarged) { enlarged.width = 0; enlarged.height = 0; } }
    }
    for (const source of sources) {
      signal.throwIfAborted();
      const bytes = Uint8Array.from(atob(source.data), char => char.charCodeAt(0));
      if (source.mimeType === 'application/pdf') {
        const pdfjs = await wait(import('pdfjs-dist'));
        const { default: workerUrl } = await wait(import('pdfjs-dist/build/pdf.worker.min.mjs?url'));
        pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
        pdfTask = pdfjs.getDocument({ data: bytes, isEvalSupported: false, cMapUrl: `${base}cmaps/`, cMapPacked: true,
          standardFontDataUrl: `${base}standard_fonts/`, wasmUrl: `${base}wasm/` });
        try {
          const document = await wait(pdfTask.promise);
          if (pages.length + document.numPages > MAX_PAGES) throw new Error(`每次最多辨識 ${MAX_PAGES} 頁，請分批上傳；本次結果未送出。`);
          for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
            const page = await wait(document.getPage(pageNumber));
            const viewport = page.getViewport({ scale: 1 });
            const { canvas, context, ratio } = canvasFor(viewport.width, viewport.height, 2);
            try {
              await wait(page.render({ canvas, canvasContext: context, viewport: page.getViewport({ scale: ratio }) }).promise);
              await recognize(canvas, source.name, pageNumber);
            } finally { page.cleanup(); canvas.width = 0; canvas.height = 0; }
          }
        } catch (error) {
          if (error instanceof Error && error.name === 'PasswordException') throw new Error('此 PDF 有密碼保護，請提供未加密檔案或改拍照片。');
          throw error;
        } finally { await pdfTask.destroy(); pdfTask = undefined; }
      } else {
        // Image decoding and all OCR run in this browser; the file is never uploaded.
        const decoding = createImageBitmap(new Blob([bytes], { type: source.mimeType }));
        decoding.then(bitmap => { if (stopReason) bitmap.close(); }, () => {});
        const bitmap = await wait(decoding);
        try {
          const size = ocrImageSize(bitmap.width, bitmap.height, target);
          const { canvas, context } = canvasFor(size.width, size.height);
          context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
          let enlarged: HTMLCanvasElement | undefined;
          if (target === 'pill' && Math.max(bitmap.width, bitmap.height) < 1280) {
            const extra = canvasFor(bitmap.width, bitmap.height, 1280 / Math.max(bitmap.width, bitmap.height));
            extra.context.drawImage(bitmap, 0, 0, extra.canvas.width, extra.canvas.height);
            enlarged = extra.canvas;
          }
          await recognize(canvas, source.name, 1, true, enlarged);
        } finally { bitmap.close(); }
      }
    }
    return pages;
  } catch (error) {
    if (stopReason) throw stopReason;
    throw new Error(error instanceof Error ? `本機辨識未完成：${error.message}` : '本機辨識失敗，請重新拍攝或手動輸入。');
  } finally {
    clearTimeout(timeout); signal.removeEventListener('abort', abort);
    await worker?.terminate();
    labelReader?.terminate();
  }
}
