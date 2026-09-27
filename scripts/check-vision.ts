import 'dotenv/config';
import Database from 'better-sqlite3';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { imageEmbedding } from '../server/vision/model.mjs';
import { INDEX_PATH, IMAGE_ROOT, MODEL_VERSION } from '../server/vision/config.mjs';
import { VisionService } from '../server/vision/service';
import { getTfda, type DrugDatabase } from '../server/medications/store';
import { eligibleForPillSearch } from '../shared/medication-vision';

// Integration smoke check using reference-derived images, not independent accuracy validation.
const drugs = new Database(process.env.DRUG_DB_PATH || 'data/drugs.db', { readonly: true }) as DrugDatabase;
const index = new Database(INDEX_PATH, { readonly: true });
const service = new VisionService(drugs);
const originalFetch = globalThis.fetch;
let networkAttempts = 0;
globalThis.fetch = async () => { networkAttempts++; throw new Error('Network is disabled during the vision smoke check'); };
try {
  const status = service.status();
  assert.ok(status.ready, status.reason);
  const indexed = index.prepare('SELECT drug_id,source_url,sha256 FROM images WHERE model=? ORDER BY drug_id,key').all(MODEL_VERSION) as { drug_id: string; source_url: string; sha256: string }[];
  // Match the served pill collection: retained injection/cream references must
  // not become expected pill matches just because their files are on disk.
  const rows = indexed.filter(row => {
    const drug = getTfda(drugs, row.drug_id);
    return drug && eligibleForPillSearch(drug) && drug.appearance?.imageUrls.includes(row.source_url) && existsSync(path.join(IMAGE_ROOT, `${row.sha256}.webp`));
  });
  assert.equal(rows.length, status.imageCount, 'Smoke-test population must match the usable pill reference collection');
  const samples = Array.from({ length: Math.min(8, rows.length) }, (_, i) => rows[Math.floor(i * rows.length / 8)]);
  const output = path.resolve('test-results'); await mkdir(output, { recursive: true });
  const results = [];
  for (const [i, row] of samples.entries()) {
    const reference = await readFile(path.join(IMAGE_ROOT, `${row.sha256}.webp`));
    const bytes = await sharp(reference).rotate(12, { background: '#f4f4f4' }).resize({ width: 480 }).jpeg({ quality: 80 }).toBuffer();
    if (!i) await writeFile(path.join(output, 'vision-pill-query.jpg'), bytes);
    const start = performance.now();
    const result = await service.search([bytes], '', new AbortController().signal);
    const rank = result.candidates.findIndex(candidate => candidate.drug.id === row.drug_id) + 1;
    const check = { expected: row.drug_id, rankWithinEight: rank || null, ms: Math.round(performance.now() - start),
      top: result.candidates[0]?.drug.id, score: result.candidates[0]?.similarity };
    results.push(check); console.log(JSON.stringify(check));
  }
  const blank = await sharp({ create: { width: 300, height: 300, channels: 3, background: '#ffffff' } }).png().toBuffer();
  await writeFile(path.join(output, 'vision-blank.png'), blank);
  await assert.rejects(imageEmbedding(blank), /幾乎沒有可辨識的細節/);
  assert.equal(networkAttempts, 0);
  // An optional real input is only read locally; never copied into the index or used as a label.
  const optionalPath = process.argv[2];
  let optionalQuery;
  if (optionalPath) {
    const result = await service.search([await readFile(optionalPath)], '', new AbortController().signal);
    optionalQuery = { outcome: result.outcome, top: result.candidates.slice(0, 3).map(candidate => ({ name: candidate.drug.name, score: candidate.similarity })) };
    console.log(JSON.stringify({ optionalQuery }));
  }
  const report = { checkedAt: new Date().toISOString(), status, networkAttempts, blankRejected: true, results, optionalQuery,
    sampling: { population: 'runtime-eligible-pill-references', count: rows.length, excludedIndexRows: indexed.length - rows.length },
    limitation: 'Reference-derived rotation/JPEG smoke check only; not real-world pill identification accuracy.' };
  await writeFile(path.join(output, 'vision-smoke.json'), JSON.stringify(report, null, 2));
  console.log(`Reference-derived checks: ${results.filter(result => result.rankWithinEight).length}/${results.length} found within 8 candidates. Not clinical accuracy.`);
} finally { globalThis.fetch = originalFetch; index.close(); drugs.close(); }
