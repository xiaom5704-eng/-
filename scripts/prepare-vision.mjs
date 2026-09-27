import 'dotenv/config';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { MODEL_ID, MODEL_REVISION, MODEL_PATH, VISION_ROOT, GALLERY_REVISION } from '../server/vision/config.mjs';
import { downloadVerified, sha256 } from './verified-download.mjs';

// Hashes checked against a fresh download of the pinned revisions on 2026-09-21.
// Updating a revision requires reviewing and updating its expected artifacts too.
if (MODEL_REVISION !== 'c2bb04a51fab207c420665f1946016107bffc701' || GALLERY_REVISION !== '3370346474892c7df2ade7a0f73ad892fce3636f')
  throw new Error('模型或圖庫版本已改變，請先核對新版本的預期 SHA-256，不可沿用舊檔案。');
const artifacts = {
  'config.json': '471007e1c59df520030a2690998f4e0ba5d810bc4f959d1984f630d198faa07e',
  'preprocessor_config.json': '14e780d86fa1861f8751f868d7f45425b5feb55c38ca26f152ca5097ab30f828',
  'onnx/model_quantized.onnx': '3afdc8bc63b50558d6e5770f5b799bb82455c2311183a2de43803f343a29d917',
};

await mkdir(MODEL_PATH, { recursive: true });
const files = {};
for (const [name, hash] of Object.entries(artifacts)) {
  console.log(`準備本機模型：${name}`);
  const bytes = await downloadVerified(`https://huggingface.co/${MODEL_ID}/resolve/${MODEL_REVISION}/${name}`, path.join(MODEL_PATH, name), hash, 40_000_000);
  files[name] = { bytes: bytes.length, sha256: sha256(bytes) };
}
await writeFile(path.join(MODEL_PATH, 'provenance.json'), JSON.stringify({ model: MODEL_ID, revision: MODEL_REVISION, files, source: 'https://github.com/facebookresearch/dinov2', license: 'Apache-2.0' }, null, 2));
await downloadVerified('https://raw.githubusercontent.com/facebookresearch/dinov2/main/LICENSE', path.join(MODEL_PATH, 'LICENSE'), '600cc67cc4cb2f5ea317dcfc687ad1c74dc4bec8782bbe9db0afd83513b935b7', 30_000);
console.log('下載固定版本的 TFDA 參考圖鏡像（只讀資料，不執行外部程式）…');
const archive = await downloadVerified(`https://codeload.github.com/liangRXdev/pill-detective-tw/zip/${GALLERY_REVISION}`, path.join(VISION_ROOT, 'reference-source.zip'), '716d0246b1e21a2fdf924c1b2fa2d29dfa8e9733052962fbe43638cb5ce526cb', 180_000_000);
await writeFile(path.join(VISION_ROOT, 'reference-provenance.json'), JSON.stringify({ revision: GALLERY_REVISION, bytes: archive.length, sha256: sha256(archive) }, null, 2));
console.log('模型與參考圖來源已準備完成。接著執行 npm run vision:index。');
