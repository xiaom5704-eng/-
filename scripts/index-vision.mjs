import 'dotenv/config';
import Database from 'better-sqlite3';
import AdmZip from 'adm-zip';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { imageEmbedding } from '../server/vision/model.mjs';
import { VisionIndexBuild, saveVerifiedImage } from './vision-index-build.mjs';
import { officialPillInputs, visionReferenceKey } from './vision-official-inputs.ts';
import { getTfda } from '../server/medications/store.ts';
import { eligibleForPillSearch } from '../shared/medication-vision.ts';
import { VISION_ROOT, IMAGE_ROOT, INDEX_PATH, MODEL_VERSION, GALLERY_REVISION, GALLERY_REPO, DIMENSIONS } from '../server/vision/config.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
await mkdir(IMAGE_ROOT, { recursive: true });
const archive = new AdmZip(await readFile(path.join(VISION_ROOT, 'reference-source.zip')));
const prefix = `pill-detective-tw-${GALLERY_REVISION}/`;
const gallery = JSON.parse(archive.readAsText(prefix + 'data/appearance.json'));
if (!Array.isArray(gallery.items) || gallery.meta?.schema !== 1) throw new Error('參考資料格式不符，未更新索引。');
const drugs = new Database(process.env.DRUG_DB_PATH || 'data/drugs.db', { readonly: true });
const db = new Database(INDEX_PATH);
try {
const build = new VisionIndexBuild(db, MODEL_VERSION, DIMENSIONS);
const rows = [];
let unmatched = 0;
for (const item of gallery.items) {
  const local = drugs.prepare('SELECT name,payload FROM tfda_appearances WHERE id=?').get(item.id);
  if (!local) { unmatched++; continue; }
  const appearance = JSON.parse(local.payload);
  // Only index oral solid appearances; package/bag photos use OCR instead.
  if (/液劑|粉劑|顆粒|散劑/.test(appearance.shape)) continue;
  for (const img of item.imgs || []) {
    if (!appearance.imageUrls.includes(img.src) || !/^img\/[a-f0-9]+-\d+\.webp$/.test(img.file) || !/^[a-f0-9]{64}$/.test(img.sha256)) { unmatched++; continue; }
    rows.push({ key: visionReferenceKey(item.id, img.src), id: item.id, src: img.src, sha: img.sha256, file: img.file });
  }
}
const official = await officialPillInputs(drugs, path.join(VISION_ROOT, 'originals'), new Set(rows.map(row => row.key)));
rows.push(...official);
if (!rows.length) throw new Error('沒有與本機 TFDA 許可證及原圖連結一致的照片，保留原索引。');
const meta = { total: rows.length,
  sourceVersion: gallery.meta.source_version, mirrorRevision: GALLERY_REVISION, mirrorUrl: GALLERY_REPO,
  sourceUrl: 'https://data.gov.tw/dataset/9120', license: '政府資料開放授權條款第 1 版；鏡像整理程式 MIT', unmatched,
  officialOriginals: official.map(({ key, sha, original }) => ({ key, indexedSha256: sha, ...original })),
  officialTransform: 'webp-q95-max1600-v1' };
let complete = 0, reused = 0;
const failures = [];
for (const row of rows) {
  try {
    const image = row.bytes ? undefined : archive.getEntry(prefix + 'data/' + row.file);
    if (!row.bytes && (!image || image.header.size > 8_000_000)) throw new Error('圖檔不存在或大小超限');
    const bytes = row.bytes || image.getData();
    if (hash(bytes) !== row.sha) throw new Error('圖片雜湊不符');
    let embedding = build.reusable(row);
    if (embedding) { reused++; }
    else {
      // Validate compressed images even though they come from a pinned public snapshot.
      await sharp(bytes, { limitInputPixels: 24_000_000 }).metadata();
      const vector = await imageEmbedding(bytes);
      embedding = Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
    }
    await saveVerifiedImage(IMAGE_ROOT, row.sha, bytes);
    build.stage(row, embedding);
    complete++;
  } catch (error) { failures.push({ id: row.id, source: row.src, error: error.message }); }
  if ((complete + failures.length) % 100 === 0) console.log(`影像索引 ${complete + failures.length}/${rows.length}，成功 ${complete}，沿用 ${reused}，失敗 ${failures.length}`);
  // Stop a broken model/runtime early. Any failure prevents partial publication.
  if (failures.length >= 3 && !complete) break;
}
await writeFile(path.join(VISION_ROOT, 'index-failures.json'), JSON.stringify(failures, null, 2));
if (failures.length) throw Error(`本次有 ${failures.length} 筆圖片無法完成，未發布新索引；既有可用索引保留，可修復後重跑。`);
for (const row of official) {
  const drug = getTfda(drugs, row.id);
  if (!drug || !eligibleForPillSearch(drug) || !drug.appearance?.imageUrls.includes(row.src))
    throw Error('官方圖片的品項或來源已變更，保留原索引，請重新執行。');
}
await writeFile(path.join(VISION_ROOT, 'mirror-LICENSE.txt'), archive.readAsText(prefix + 'LICENSE'));
await writeFile(path.join(VISION_ROOT, 'ATTRIBUTION.txt'), `衛生福利部食品藥物管理署 ${gallery.meta.source_version} 藥品外觀資料集\nhttps://data.gov.tw/dataset/9120\n政府資料開放授權條款第1版 https://data.gov.tw/license\n圖片鏡像：${GALLERY_REPO}\n固定版本：${GALLERY_REVISION}\n鏡像圖逐張核對原始網址、許可證與 SHA-256。另補入 ${official.length} 筆已下載的官方原圖，原始雜湊、取得日期與轉換紀錄保存在索引 metadata.officialOriginals；既有鏡像圖不替換。圖片壓縮為 WebP，供候選外觀比對。\n`);
console.log(JSON.stringify(build.publish(meta, rows), null, 2));
} finally { drugs.close(); db.close(); }
