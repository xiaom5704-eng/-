import sharp from 'sharp';
import { MODEL_ID, MODEL_ROOT, DIMENSIONS } from './config.mjs';

let starting;
async function extractor() {
  if (!starting) starting = (async () => {
    const { env, pipeline, RawImage } = await import('@huggingface/transformers');
    env.allowRemoteModels = false;
    env.allowLocalModels = true;
    env.useFSCache = false;
    env.localModelPath = MODEL_ROOT + '/';
    const pipe = await pipeline('image-feature-extraction', MODEL_ID, {
      dtype: 'q8', local_files_only: true,
      session_options: { intraOpNumThreads: 4, interOpNumThreads: 1 },
    });
    // Keep the whole pill: the standard centre crop can remove imprints near an edge.
    pipe.processor.image_processor.do_resize = false;
    pipe.processor.image_processor.do_center_crop = false;
    return { pipe, RawImage };
  })().catch(error => { starting = undefined; throw error; });
  return starting;
}

export async function imageEmbedding(bytes) {
  const input = sharp(bytes, { limitInputPixels: 24_000_000, animated: false });
  const metadata = await input.metadata();
  if (!['jpeg', 'png', 'webp'].includes(metadata.format) || (metadata.pages || 1) > 1) throw new Error('請使用單張 JPEG、PNG 或 WebP 照片。');
  if (Math.min(metadata.width || 0, metadata.height || 0) < 32) throw new Error('照片太小，請使用較清楚的藥物照片。');
  const originalStats = await input.clone().stats();
  // Check before letterboxing too: padding must not turn a solid-color image into "detail".
  if (originalStats.channels.every(channel => channel.stdev ** 2 < 12)) throw new Error('照片幾乎沒有可辨識的細節，請重新拍攝或裁切藥錠。');
  const { data, info } = await input.rotate().flatten({ background: '#fff' })
    .resize(224, 224, { fit: 'contain', background: '#fff' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const sums = Array(info.channels).fill(0), squares = Array(info.channels).fill(0);
  for (let i = 0; i < data.length; i++) { const c = i % info.channels; sums[c] += data[i]; squares[c] += data[i] ** 2; }
  const pixels = info.width * info.height;
  const variance = sums.reduce((total, sum, c) => total + squares[c] / pixels - (sum / pixels) ** 2, 0) / info.channels;
  if (variance < 12) throw new Error('照片幾乎沒有可辨識的細節，請重新拍攝或裁切藥錠。');
  const { pipe, RawImage } = await extractor();
  const output = await pipe(new RawImage(new Uint8ClampedArray(data), info.width, info.height, info.channels));
  // DINOv2's first token is the CLS embedding (the remaining tokens describe patches).
  const vector = Float32Array.from(output.data.slice(0, DIMENSIONS));
  if (vector.length !== DIMENSIONS || !vector.every(Number.isFinite)) throw new Error('影像模型輸出格式無效。');
  const norm = Math.hypot(...vector);
  if (norm < 1e-8) throw new Error('影像特徵不足。');
  return vector.map(value => value / norm);
}
