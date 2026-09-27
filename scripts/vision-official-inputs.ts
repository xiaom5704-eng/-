import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import sharp from 'sharp';
import { getTfda, type DrugDatabase } from '../server/medications/store';
import { allowedOriginalUrl, ORIGINAL_TRANSFORM, type OriginalReference } from '../server/vision/reference-originals';
import { eligibleForPillSearch } from '../shared/medication-vision';

const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export const visionReferenceKey = (id: string, url: string) => hash(id + '\0' + url);

// Supplement missing source links only. A higher-resolution copy must not
// silently replace the published mirror's image or change its existing vector.
export async function officialPillInputs(drugs: DrugDatabase, root: string, existingKeys: Set<string>) {
  const file = path.join(root, 'index.db');
  if (!existsSync(file)) return [];
  const index = new Database(file, { readonly: true, fileMustExist: true });
  let originals: OriginalReference[];
  try { originals = index.prepare('SELECT * FROM reference_originals WHERE transform=? ORDER BY drug_id,source_url').all(ORIGINAL_TRANSFORM) as OriginalReference[]; }
  finally { index.close(); }
  const inputs = [];
  for (const original of originals) {
    const { drug_id: id, source_url: src } = original, key = visionReferenceKey(id, src);
    const drug = getTfda(drugs, id);
    if (existingKeys.has(key) || !allowedOriginalUrl(src) || !drug || !eligibleForPillSearch(drug) || !drug.appearance?.imageUrls.includes(src)) continue;
    if (!/^[a-f0-9]{64}$/.test(original.sha256) || !/^[a-f0-9]{64}$/.test(original.source_sha256)) throw Error(`官方參考圖雜湊無效：${id}`);
    const saved = await readFile(path.join(root, 'images', `${original.sha256}.webp`));
    if (hash(saved) !== original.sha256) throw Error(`官方參考圖內容已變更：${id}`);
    const input = sharp(saved, { limitInputPixels: 80_000_000, animated: false });
    const metadata = await input.metadata();
    if (metadata.format !== 'webp' || (metadata.pages || 1) !== 1 || metadata.width !== original.width || metadata.height !== original.height)
      throw Error(`官方參考圖格式或尺寸不符：${id}`);
    const bytes = await input.resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true }).webp({ quality: 95 }).toBuffer();
    inputs.push({ key, id, src, sha: hash(bytes), bytes, original });
  }
  return inputs;
}
