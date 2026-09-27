import { PaddleOCR } from '@paddleocr/paddleocr-js';
import { ocrRegions } from '../../shared/medication-ocr';

// Keep initialization and inference in a dedicated Worker. Abort terminates it even
// during model loading; all model/WASM URLs are served by this application.
export function createLabelReader(base: string) {
  let worker: Worker | undefined;
  let stopped = false;
  let engine: ReturnType<typeof PaddleOCR.create> | undefined;
  return {
    terminate() { stopped = true; worker?.terminate(); },
    async recognize(canvas: HTMLCanvasElement) {
      if (stopped) throw new DOMException('已取消本機辨識。', 'AbortError');
      engine ??= PaddleOCR.create({
        worker: { createWorker: () => {
          if (stopped) throw new DOMException('已取消本機辨識。', 'AbortError');
          worker = new Worker(`${base}paddle/worker.js`, { type: 'module' });
          return worker;
        } },
        textDetectionModelName: 'PP-OCRv5_mobile_det',
        textRecognitionModelName: 'PP-OCRv5_mobile_rec',
        textDetectionModelAsset: { url: `${base}paddle/PP-OCRv5_mobile_det.tar` },
        textRecognitionModelAsset: { url: `${base}paddle/PP-OCRv5_mobile_rec.tar` },
        ortOptions: { backend: 'wasm', wasmPaths: `${base}paddle/`, numThreads: 1 },
      });
      const ocr = await engine;
      if (stopped) throw new DOMException('已取消本機辨識。', 'AbortError');
      const [result] = await ocr.predict(canvas, { textDetLimitSideLen: 1280, textDetLimitType: 'max', textRecScoreThresh: 0.35 });
      const items = result.items.filter(item => item.text.trim());
      return { text: items.map(item => item.text.trim()).join('\n'),
        regions: ocrRegions(items, result.image.width, result.image.height),
        confidence: items.length ? 100 * items.reduce((sum, item) => sum + item.score, 0) / items.length : 0 };
    },
  };
}
