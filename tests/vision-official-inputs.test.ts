import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { openDrugDatabase } from '../server/medications/store';
import { ReferenceOriginals } from '../server/vision/reference-originals';
import { officialPillInputs, visionReferenceKey } from '../scripts/vision-official-inputs';
import { VisionIndexBuild, saveVerifiedImage } from '../scripts/vision-index-build.mjs';
import { VisionService } from '../server/vision/service';
import { MODEL_VERSION, DIMENSIONS } from '../server/vision/config.mjs';

async function fixture(t: test.TestContext) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'medsafe-official-inputs-'));
  const drugs = openDrugDatabase(':memory:'), originals = path.join(root, 'originals');
  t.after(() => { drugs.close(); assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('medsafe-official-inputs-')); rmSync(root, { recursive: true, force: true }); });
  const url = 'https://mcp.fda.gov.tw/insert/shapeImg/11111111-1111-1111-1111-111111111111_img_1?c=o';
  const bytes = await sharp({ create: { width: 1900, height: 900, channels: 3, background: '#aabbcc' } }).webp().toBuffer();
  for (const [id, shape, form] of [['PILL', '圓形', '錠劑'], ['LIQUID', '液劑(包含糖漿用粉劑)', '糖漿劑'], ['STALE', '圓形', '錠劑']]) {
    const drug = { id, name: id, englishName: id, source: 'tfda', dosageForm: form, ingredients: ['TEST'] };
    drugs.prepare('INSERT INTO tfda_drugs VALUES (?,?,?,?,?,?)').run(id, id, id, id, 1, JSON.stringify(drug));
    drugs.prepare('INSERT INTO tfda_appearances VALUES (?,?,?,?,?)').run(id, id, id, id, JSON.stringify({ shape, imageUrls: [url] }));
    await new ReferenceOriginals(drugs, originals).download(id, url, async () => new Response(new Uint8Array(bytes)));
  }
  drugs.prepare('UPDATE tfda_appearances SET payload=? WHERE id=?').run(JSON.stringify({ shape: '圓形', imageUrls: [url + '&changed=1'] }), 'STALE');
  const update = (sql: string, ...args: unknown[]) => { const db = new Database(path.join(originals, 'index.db')); try { db.prepare(sql).run(...args); } finally { db.close(); } };
  return { root, drugs, originals, url, update };
}

test('Official supplements use current exact licenses and URLs, exclude non-pill sources and preserve mirror priority', async t => {
  const f = await fixture(t);
  assert.deepEqual(await officialPillInputs(f.drugs, path.join(f.root, 'missing'), new Set()), []);
  const rows = await officialPillInputs(f.drugs, f.originals, new Set());
  assert.deepEqual(rows.map(row => row.id), ['PILL']);
  const row = rows[0], image = await sharp(row.bytes).metadata();
  assert.equal(image.width, 1600); assert.equal(row.key, visionReferenceKey('PILL', f.url));
  assert.equal(createHash('sha256').update(row.bytes).digest('hex'), row.sha);
  assert.equal(row.original.drug_id, row.id); assert.equal(row.original.source_url, row.src); assert.ok(row.original.fetched_at);
  assert.equal((await officialPillInputs(f.drugs, f.originals, new Set()))[0].sha, row.sha, 'repeat builds retain identical image bytes');
  assert.deepEqual(await officialPillInputs(f.drugs, f.originals, new Set([row.key])), []);
  f.update('UPDATE reference_originals SET source_url=? WHERE drug_id=?', 'https://example.test/foreign', 'PILL');
  assert.deepEqual(await officialPillInputs(f.drugs, f.originals, new Set()), []);
});

test('Corrupt official images, dimensions or index fail rather than publishing partial supplements', async t => {
  const f = await fixture(t), [row] = await officialPillInputs(f.drugs, f.originals, new Set());
  const file = path.join(f.originals, 'images', `${row.original.sha256}.webp`), original = readFileSync(file);
  writeFileSync(file, 'broken');
  await assert.rejects(officialPillInputs(f.drugs, f.originals, new Set()), /內容已變更/);
  writeFileSync(file, original);
  f.update('UPDATE reference_originals SET width=1 WHERE drug_id=?', 'PILL');
  await assert.rejects(officialPillInputs(f.drugs, f.originals, new Set()), /尺寸不符/);
  f.update('UPDATE reference_originals SET sha256=? WHERE drug_id=?', '../outside', 'PILL');
  await assert.rejects(officialPillInputs(f.drugs, f.originals, new Set()), /雜湊無效/);
  writeFileSync(path.join(f.originals, 'index.db'), 'broken index');
  await assert.rejects(officialPillInputs(f.drugs, f.originals, new Set()));
});

test('Official supplements become local visual candidates only after full publication and exclude changed source records', async t => {
  const f = await fixture(t), [row] = await officialPillInputs(f.drugs, f.originals, new Set());
  const images = path.join(f.root, 'images'), models = path.join(f.root, 'models'), file = path.join(f.root, 'index.db');
  mkdirSync(images); mkdirSync(path.join(models, 'onnx'), { recursive: true }); writeFileSync(path.join(models, 'onnx/model_quantized.onnx'), 'synthetic');
  const vector = new Float32Array(DIMENSIONS); vector[0] = 1;
  const service = new VisionService(f.drugs, file, images, models, async () => vector);
  const db = new Database(file);
  try {
    const build = new VisionIndexBuild(db, MODEL_VERSION, DIMENSIONS);
    build.stage(row, Buffer.from(vector.buffer)); await saveVerifiedImage(images, row.sha, row.bytes);
    assert.equal(service.status().ready, false);
    build.publish({ officialOriginals: [{ key: row.key, indexedSha256: row.sha, ...row.original }] }, [row]);
    assert.equal(service.status().imageCount, 1);
    assert.equal((await service.search([Buffer.from('synthetic')], '', new AbortController().signal)).candidates[0].drug.id, 'PILL');
    assert.equal(service.imagePath(row.sha), path.join(images, `${row.sha}.webp`));
    f.drugs.prepare('UPDATE tfda_appearances SET payload=? WHERE id=?').run(JSON.stringify({ shape: '圓形', imageUrls: [] }), 'PILL');
    f.drugs.prepare('UPDATE drug_search_meta SET revision=revision+1').run(); // Same revision change as the source importer.
    assert.equal(service.status().ready, false);
  } finally { db.close(); }
});
