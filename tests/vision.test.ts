import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import express from 'express';
import { listenForFetch } from './http-listener';
import { rankVisualReferences, compareImprint, eligibleForPillSearch, type VisionResult } from '../shared/medication-vision';
import { decodeVisionRequest, visionRouter } from '../server/vision/router';
import { VisionService } from '../server/vision/service';
import { openDrugDatabase } from '../server/medications/store';
import { MODEL_VERSION, DIMENSIONS } from '../server/vision/config.mjs';
import { readMedicationScan } from '../src/services/medication-scan';
import sharp from 'sharp';
import { imageEmbedding } from '../server/vision/model.mjs';
import { LocalMedicationImages } from '../server/medications/local-images';

test('Pill retrieval excludes explicit non-pill formulations without guessing administration routes', () => {
  for (const dosageForm of ['錠劑', '陰道錠', '膠囊劑', '丸劑', '', '未分類', '乾粉吸入劑']) assert.ok(eligibleForPillSearch({ dosageForm }));
  for (const dosageForm of ['注射劑', '凍晶注射劑', '點眼液劑', '乳膏劑', '外用凝膠劑', '醫用氣體(氣態)', '口溶膜'])
    assert.equal(eligibleForPillSearch({ dosageForm }), false);
});

test('Pill retrieval respects source non-pill appearance even when a dosage-form name is absent or unfamiliar', () => {
  for (const dosageForm of ['糖漿劑', '酏劑', '滴劑', '洗髮劑', '擦劑', '（粉）', ''])
    assert.equal(eligibleForPillSearch({ dosageForm, appearance: { shape: '液劑(包含糖漿用粉劑)' } }), false);
  assert.equal(eligibleForPillSearch({ dosageForm: '', appearance: { shape: '顆粒劑、粉劑或散劑' } }), false);
  assert.equal(eligibleForPillSearch({ dosageForm: '糖漿劑' }), false);
  assert.equal(eligibleForPillSearch({ dosageForm: '膠囊劑', appearance: { shape: '膠囊' } }), true);
});

test('Real image decoding rejects uniform white and colored photos before loading a model', async () => {
  for (const background of ['#fff', '#ff0000']) {
    const bytes = await sharp({ create: { width: 320, height: 200, channels: 3, background } }).png().toBuffer();
    await assert.rejects(imageEmbedding(bytes), /幾乎沒有可辨識的細節/);
  }
  const tiny = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#fff' } }).jpeg().toBuffer();
  await assert.rejects(imageEmbedding(tiny), /照片太小/);
});

test('Visual retrieval groups reference sides by drug and requires both query views to agree', () => {
  const refs = [
    { key: 'a-front', drugId: 'A', vector: new Float32Array([1, 0]) },
    { key: 'a-back', drugId: 'A', vector: new Float32Array([0, 1]) },
    { key: 'b', drugId: 'B', vector: new Float32Array([1, 0]) },
  ];
  const result = rankVisualReferences([new Float32Array([1, 0]), new Float32Array([0, 1])], refs);
  assert.equal(result.length, 1); assert.equal(result[0].drugId, 'A');
  assert.deepEqual(result[0].views.map(view => view.key), ['a-front', 'a-back']);
  assert.equal(result[0].similarity, 1);
});

test('Unrelated vectors abstain and distinct drugs with identical photos remain separate candidates', () => {
  const refs = ['A', 'B'].map(drugId => ({ key: drugId, drugId, vector: new Float32Array([1, 0]) }));
  assert.equal(rankVisualReferences([new Float32Array([0, 1])], refs).length, 0);
  assert.equal(rankVisualReferences([new Float32Array([1, 0])], refs).length, 2);
  assert.throws(() => rankVisualReferences([], refs));
  assert.throws(() => rankVisualReferences([new Float32Array([NaN, 0])], refs));
});

test('Malformed vector magnitudes cannot outrank valid photos with a clamped perfect similarity', () => {
  const query = new Float32Array([1, 0]);
  const refs = [
    { key: 'valid', drugId: 'VALID', vector: new Float32Array([0.8, 0.6]) },
    { key: 'oversized', drugId: 'INVALID', vector: new Float32Array([100, 100]) },
    { key: 'empty', drugId: 'EMPTY', vector: new Float32Array([0, 0]) },
  ];
  const result = rankVisualReferences([query], refs, 8, -1);
  assert.deepEqual(result.map(row => row.drugId), ['VALID']);
  assert.ok(Math.abs(result[0].similarity - 0.8) < 0.00001);
  for (const invalid of [[0, 0], [100, 100], [0.4, 0.3], [Infinity, 0]])
    assert.throws(() => rankVisualReferences([new Float32Array(invalid)], refs), /特徵格式/);
});

test('Imprint evidence preserves uncertain digits, missing data, and exact matches', () => {
  const appearance = { shape: '', color: '', score: '', size: '', imprint1: 'FY T061;;;AB', imprint2: '', imageUrls: [], sourceUrl: '' };
  assert.equal(compareImprint('ｆｙ t061', appearance), 'match');
  assert.equal(compareImprint('FY TO61', appearance), 'different');
  assert.equal(compareImprint('FY T061'), 'missing');
  assert.equal(compareImprint('', appearance), 'not_given');
});

test('Photo endpoint rejects URLs, PDFs, excessive files and huge input before decoding', () => {
  for (const body of [null, {}, { images: [] }, { images: ['https://example.test/photo.png'] },
    { images: ['data:application/pdf;base64,AAAA'] }, { images: ['data:image/png;base64,A'] },
    { images: ['data:image/png;base64,AAAA'], imprint: {} }, { images: Array(3).fill('data:image/png;base64,AAAA') },
    { images: ['data:image/png;base64,' + 'A'.repeat(11_200_000)] }]) assert.throws(() => decodeVisionRequest(body));
  const decoded = decodeVisionRequest({ images: ['data:image/png;base64,AAAA'], imprint: ' AB ' });
  assert.equal(decoded.imprint, 'AB'); assert.equal(decoded.images[0].length, 3);
});

test('CV mode invokes only the local vision reader and never falls back to a cloud key', async () => {
  let cloudCalls = 0;
  const options = { target: 'pill' as const, signal: new AbortController().signal, onProgress: () => {} };
  const dependencies = { local: async () => [], gemini: async () => { cloudCalls++; return []; }, vision: async () => { throw new Error('Synthetic failure'); } };
  await assert.rejects(readMedicationScan('vision', [{ name: 'synthetic.png', data: 'data:image/png;base64,AAAA' }], 'not-used', options, dependencies), /Synthetic failure/);
  assert.equal(cloudCalls, 0);
});

test('Index joins authoritative local drugs, excludes stale source URLs and serves only indexed images', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'medsafe-vision-'));
  const drugs = openDrugDatabase(':memory:');
  const indexPath = path.join(root, 'index.db'), imageRoot = path.join(root, 'images'), modelRoot = path.join(root, 'models');
  mkdirSync(imageRoot); mkdirSync(path.join(modelRoot, 'onnx'), { recursive: true });
  writeFileSync(path.join(modelRoot, 'onnx/model_quantized.onnx'), 'synthetic');
  const sha = 'a'.repeat(64), staleSha = 'b'.repeat(64);
  for (const value of [sha, staleSha]) writeFileSync(path.join(imageRoot, value + '.webp'), 'synthetic');
  const index = new Database(indexPath);
  try {
    const drug = { source: 'tfda', id: 'SYNTHETIC', name: '人工測試藥品', englishName: 'Synthetic', ingredients: ['Synthetic ingredient'], dosageForm: '', manufacturer: '', licenseStatus: '', validUntil: '', indications: '', dosageText: '', sourceUrl: 'https://example.test' };
    drugs.prepare('INSERT INTO tfda_drugs VALUES (?,?,?,?,?,?)').run(drug.id, drug.name, drug.englishName, 'synthetic', 1, JSON.stringify(drug));
    const appearance = { shape: '圓形', color: '白', score: '', size: '', imprint1: 'TEST', imprint2: '', imageUrls: ['https://example.test/current.webp'], sourceUrl: '' };
    drugs.prepare('INSERT INTO tfda_appearances VALUES (?,?,?,?,?)').run(drug.id, drug.name, drug.englishName, 'synthetic', JSON.stringify(appearance));
    drugs.prepare('INSERT INTO tfda_appearance_terms VALUES (?,?,?)').run(drug.id, 'imprint', 'test');
    index.exec('CREATE TABLE metadata(key TEXT, value TEXT); CREATE TABLE images(key TEXT,drug_id TEXT,source_url TEXT,sha256 TEXT,model TEXT,embedding BLOB);');
    index.prepare('INSERT INTO metadata VALUES (?,?)').run('index', JSON.stringify({ state: 'ready', modelVersion: MODEL_VERSION, indexedAt: 'synthetic' }));
    const vector = new Float32Array(DIMENSIONS); vector[0] = 1;
    for (const [key, url, hash] of [['good', appearance.imageUrls[0], sha], ['stale', 'https://example.test/old.webp', staleSha]]) {
      index.prepare('INSERT INTO images VALUES (?,?,?,?,?,?)').run(key, drug.id, url, hash, MODEL_VERSION, Buffer.from(vector.buffer));
    }
    for (const value of [0, 2, 0.5]) {
      const invalid = new Float32Array(DIMENSIONS); invalid[0] = value;
      index.prepare('INSERT INTO images VALUES (?,?,?,?,?,?)').run(`bad-norm-${value}`, drug.id, appearance.imageUrls[0], sha, MODEL_VERSION, Buffer.from(invalid.buffer));
    }
    let inferenceCalls = 0;
    const service = new VisionService(drugs, indexPath, imageRoot, modelRoot, async () => { inferenceCalls++; return vector; });
    assert.equal(service.status().imageCount, 1);
    assert.equal(service.imagePath(staleSha), null); assert.equal(service.imagePath('../outside'), null);
    const result = await service.search([Buffer.from('synthetic')], 'TEST', new AbortController().signal);
    assert.equal(result.candidates[0].drug.id, drug.id);
    assert.deepEqual(result.candidates[0].drug.ingredients, drug.ingredients);
    assert.equal(result.candidates[0].imprint, 'match');
    assert.equal(result.candidates[0].images[0].url, `/api/medications/vision/images/${sha}.webp`);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(service.search([Buffer.from('synthetic')], '', controller.signal), { name: 'AbortError' });
    assert.equal(inferenceCalls, 1);
    for (const invalid of [new Float32Array([1, 0]), new Float32Array(DIMENSIONS)]) {
      const failed = new VisionService(drugs, indexPath, imageRoot, modelRoot, async () => invalid);
      await assert.rejects(failed.search([Buffer.from('synthetic')], 'TEST', new AbortController().signal), /特徵格式/);
    }
    // A changed canonical formulation must stop appearing as a pill even from
    // the cached index, without removing the source image or medication record.
    drugs.prepare("UPDATE tfda_drugs SET payload=json_set(payload, '$.dosageForm', '注射劑') WHERE id=?").run(drug.id);
    assert.equal((await service.search([Buffer.from('synthetic')], '', new AbortController().signal)).candidates.length, 0);
    const localImages = new LocalMedicationImages(drugs, indexPath, imageRoot);
    assert.ok(localImages.fileFor(sha));
    drugs.prepare('UPDATE drug_search_meta SET revision=revision+1').run();
    assert.equal(service.status().imageCount, 0, 'source imports invalidate the CV eligibility cache');
  } finally { index.close(); drugs.close(); rmSync(root, { recursive: true, force: true }); }
});

test('Unavailable index returns 503; concurrent photo inference is bounded and status remains available', async () => {
  let ready = false, calls = 0, release: () => void = () => {};
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const status = () => ({ ready, imageCount: 1, drugCount: 1, model: 'synthetic', reason: 'Synthetic index unavailable' });
  const app = express(); app.use(express.json());
  app.use(visionRouter({ status, imagePath: () => null, search: async () => { calls++; await waiting; return { status: status(), candidates: [], warnings: [], outcome: 'low_similarity' } as VisionResult; } }));
  const server = await listenForFetch(app);
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const options = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ images: ['data:image/png;base64,AAAA'] }) };
  try {
    assert.equal((await fetch(base + '/search', options)).status, 503);
    ready = true;
    const first = fetch(base + '/search', options);
    while (!calls) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal((await fetch(base + '/search', options)).status, 429);
    assert.equal((await fetch(base + '/status')).status, 200);
    assert.equal((await fetch(base + '/images/not-a-reference.webp')).status, 404);
    release(); assert.equal((await first).status, 200);
  } finally { release(); server.close(); }
});
