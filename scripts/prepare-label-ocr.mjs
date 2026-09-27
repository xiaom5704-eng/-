import { copyFile, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const sdk = fileURLToPath(import.meta.resolve('@paddleocr/paddleocr-js'));
const sdkRequire = createRequire(sdk);
const root = path.resolve('public/ocr/paddle');
const models = [
  ['PP-OCRv5_mobile_det', '781056046c9ed77a15c94681605db6a0f62317c2e9cce6931c71da2478d4bc30'],
  ['PP-OCRv5_mobile_rec', 'f7e792bc836f36e7ef895ad47c426d75b0b75b1650caa6d63fe9418441ffba8c'],
];
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export async function prepareLabelOcr() {
  await mkdir(root, { recursive: true });
  const assets = path.join(path.dirname(sdk), 'assets');
  const worker = (await readdir(assets)).find(file => /^worker-entry-.*\.js$/.test(file));
  if (!worker) throw new Error('PaddleOCR Worker 不存在，請重新安裝依賴。');
  await copyFile(path.join(assets, worker), path.join(root, 'worker.js'));
  const ort = path.resolve(path.dirname(sdkRequire.resolve('onnxruntime-web')), '..');
  // The SDK's prebuilt Worker embeds ORT 1.24.3; package.json pins its matching WASM.
  const version = JSON.parse(await readFile(path.join(ort, 'package.json'), 'utf8')).version;
  if (version !== '1.24.3') throw new Error('PaddleOCR Worker 需要 onnxruntime-web 1.24.3。');
  for (const file of ['ort-wasm-simd-threaded.jsep.mjs', 'ort-wasm-simd-threaded.jsep.wasm']) {
    await copyFile(path.join(ort, 'dist', file), path.join(root, file));
  }
  await copyFile(path.resolve('public/ocr/tesseract.js-LICENSE.txt'), path.join(root, 'Apache-2.0.txt'));
  for (const [name, hash] of models) {
    const target = path.join(root, `${name}.tar`);
    const existing = await readFile(target).catch(() => null);
    if (existing && sha256(existing) === hash) continue;
    console.log(`首次準備本機 OCR 模型：${name}（官方下載，照片不會上傳）`);
    const response = await fetch(`https://paddle-model-ecology.bj.bcebos.com/paddlex/official_inference_model/paddle3.0.0/${name}_onnx_infer.tar`, { signal: AbortSignal.timeout(180_000) });
    if (!response.ok) throw new Error(`OCR 模型下載失敗：HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (sha256(bytes) !== hash) throw new Error(`OCR 模型校驗失敗：${name}`);
    await writeFile(`${target}.tmp`, bytes);
    await rename(`${target}.tmp`, target);
  }
  await writeFile(path.join(root, 'NOTICE.txt'), 'PaddleOCR.js 0.4.2 / PP-OCRv5 mobile models: PaddlePaddle Authors, Apache-2.0.\nhttps://github.com/PaddlePaddle/PaddleOCR\nONNX Runtime Web 1.24.3: Microsoft, MIT.\nOpenCV.js: OpenCV contributors, Apache-2.0.\n');
  console.log('藥盒／藥袋 OCR 模型及執行檔已準備完成（全部由本機提供）。');
}
