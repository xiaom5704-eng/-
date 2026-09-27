import 'dotenv/config';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import sharp from 'sharp';
import { openDrugDatabase } from '../server/medications/store';
import { PackageVisionService } from '../server/vision/packages';

const file = process.argv[2];
if (!file) throw new Error('請提供本機測試照片路徑。這只檢查搜尋，不會收錄照片。');
const db = openDrugDatabase();
const oldFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('Offline test: external fetch is disabled'); };
try {
  const service = new PackageVisionService(db);
  const original = await readFile(file);
  const rows = [];
  for (const [name, bytes] of [
    ['original', original],
    ['rotated-compressed', await sharp(original).rotate(8, { background: '#fff' }).jpeg({ quality: 60 }).toBuffer()],
    ...(process.argv[3] ? [['different-image', await readFile(process.argv[3])]] : []),
  ] as [string, Buffer][]) {
    const result = await service.search([bytes], '', new AbortController().signal);
    rows.push({ name, outcome: result.outcome, candidates: result.candidates.map(item => ({ id: item.drug.id, name: item.drug.name, similarity: item.similarity })) });
  }
  await mkdir('test-results', { recursive: true });
  await writeFile('test-results/package-smoke.json', JSON.stringify({ status: service.status(), tests: rows, note: 'Same-reference transformations only; not independent photo accuracy.' }, null, 2));
  console.log(JSON.stringify(rows, null, 2));
} finally { globalThis.fetch = oldFetch; db.close(); }
