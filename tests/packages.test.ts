import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { listenForFetch } from './http-listener';
import express from 'express';
import sharp from 'sharp';
import { openDrugDatabase } from '../server/medications/store';
import { PackageVisionService } from '../server/vision/packages';
import { VisionService } from '../server/vision/service';
import { visionRouter } from '../server/vision/router';
import { DIMENSIONS } from '../server/vision/config.mjs';
import { readMedicationScan } from '../src/services/medication-scan';

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'medsafe-packages-'));
  const index = path.join(root, 'index.db'), images = path.join(root, 'images'), models = path.join(root, 'models');
  mkdirSync(path.join(models, 'onnx'), { recursive: true }); writeFileSync(path.join(models, 'onnx/model_quantized.onnx'), 'test');
  const drugs = openDrugDatabase(':memory:');
  for (const id of ['TEST-A', 'TEST-B']) {
    const drug = { source: 'tfda', id, name: '人工測試藥盒錠', englishName: '', ingredients: [`Ingredient for ${id}`], dosageForm: '錠劑' };
    drugs.prepare('INSERT INTO tfda_drugs VALUES (?,?,?,?,?,?)').run(id, drug.name, '', drug.name, 1, JSON.stringify(drug));
  }
  const vector = new Float32Array(DIMENSIONS); vector[0] = 1;
  const service = new PackageVisionService(drugs, index, images, models, async () => vector);
  return { root, index, images, models, drugs, vector, service, close() { drugs.close(); rmSync(root, { recursive: true, force: true }); } };
}
const photo = () => sharp({ create: { width: 80, height: 60, channels: 3, background: '#286842' } }).png().toBuffer();
const signal = () => new AbortController().signal;

test('Package references link every exact-name license, preserve canonical ingredients and deduplicate photos', async () => {
  const f = fixture();
  try {
    assert.equal(f.service.status().ready, false);
    const bytes = await photo();
    const first = await f.service.register([bytes], '人工測試藥盒錠', 'Synthetic test image', signal());
    assert.equal(first.licenseCount, 2); assert.equal(first.status.imageCount, 1); assert.equal(first.status.productCount, 1);
    await f.service.register([bytes], '人工測試藥盒錠', 'Synthetic test image', signal());
    assert.equal(f.service.status().imageCount, 1);
    const result = await f.service.search([bytes], 'UNRELATED PILL MARK', signal());
    assert.equal(result.status.kind, 'package'); assert.equal(result.candidates.length, 2);
    for (const candidate of result.candidates) {
      assert.deepEqual(candidate.drug.ingredients, [`Ingredient for ${candidate.drug.id}`]);
      assert.equal(candidate.imprint, 'not_given');
      assert.match(candidate.images[0].url, /^\/api\/medications\/packages\/images\/[a-f0-9]{64}\.webp$/);
      assert.equal(candidate.images[0].sourceNote, 'Synthetic test image');
    }
    assert.equal(new VisionService(f.drugs, f.index, f.images, f.models).status().ready, false);
    const sha = path.basename(result.candidates[0].images[0].url, '.webp');
    assert.ok(f.service.imagePath(sha)); assert.equal(f.service.imagePath('../outside'), null);
    rmSync(path.join(f.models, 'onnx/model_quantized.onnx'));
    assert.equal(f.service.imagePath(sha), null, 'cached images must not bypass an unavailable index/model');
  } finally { f.close(); }
});

test('Unknown names, corrupt photos and cancellation never create a package index', async () => {
  const f = fixture();
  try {
    await assert.rejects(f.service.register([await photo()], '人工測試', 'source', signal()), /完全相同/);
    await assert.rejects(f.service.register([Buffer.from('not an image')], '人工測試藥盒錠', 'source', signal()));
    const controller = new AbortController(); controller.abort();
    await assert.rejects(f.service.register([await photo()], '人工測試藥盒錠', 'source', controller.signal), { name: 'AbortError' });
    assert.equal(existsSync(f.index), false);
  } finally { f.close(); }
});

test('Failed additions preserve prior references and changed canonical names are not returned from cache', async () => {
  const f = fixture();
  try {
    const bytes = await photo();
    await f.service.register([bytes], '人工測試藥盒錠', 'source', signal());
    const failed = new PackageVisionService(f.drugs, f.index, f.images, f.models, async () => new Float32Array([NaN]));
    await assert.rejects(failed.register([bytes], '人工測試藥盒錠', 'source', signal()), /特徵格式/);
    for (const value of [0, 0.5, 100]) {
      const invalid = new Float32Array(DIMENSIONS); invalid[0] = value;
      const bad = new PackageVisionService(f.drugs, f.index, f.images, f.models, async () => invalid);
      await assert.rejects(bad.register([bytes], '人工測試藥盒錠', 'source', signal()), /特徵格式/);
    }
    assert.equal(f.service.status().imageCount, 1);
    f.drugs.prepare('DELETE FROM tfda_drugs WHERE id=?').run('TEST-A');
    f.drugs.prepare("UPDATE tfda_drugs SET payload=json_set(payload, '$.name', ?) WHERE id=?").run('Changed product', 'TEST-B');
    assert.equal((await f.service.search([bytes], '', signal())).candidates.length, 0);
  } finally { f.close(); }
});

test('Package matching rejects weaker similarities independently of the pill threshold', async () => {
  const f = fixture();
  try {
    const bytes = await photo(); await f.service.register([bytes], '人工測試藥盒錠', 'source', signal());
    const vector = new Float32Array(DIMENSIONS); vector[0] = 0.7; vector[1] = Math.sqrt(1 - 0.49);
    const service = new PackageVisionService(f.drugs, f.index, f.images, f.models, async () => vector);
    assert.equal((await service.search([bytes], '', signal())).outcome, 'low_similarity');
  } finally { f.close(); }
});

test('Package API requires explicit collection confirmation and shares the inference queue with pill searches', async () => {
  const f = fixture();
  const app = express(); app.use(express.json());
  const queue = { busy: false }; app.use('/packages', visionRouter(f.service, queue));
  app.use('/pills', visionRouter(new VisionService(f.drugs), queue));
  const server = await listenForFetch(app);
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const body = { productName: '人工測試藥盒錠', sourceNote: 'Synthetic image', images: [`data:image/png;base64,${(await photo()).toString('base64')}`], confirmed: true };
  const post = (url: string, value: unknown) => fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
  try {
    assert.equal((await post('/packages/search', body)).status, 503);
    assert.equal((await post('/packages/references', { ...body, confirmed: false })).status, 400);
    assert.equal((await post('/packages/references', { ...body, productName: 'missing name' })).status, 422);
    assert.equal((await post('/packages/references', body)).status, 200);
    assert.equal((await post('/packages/search', body)).status, 200);
    assert.equal((await post('/pills/references', body)).status, 404);
    queue.busy = true;
    assert.equal((await post('/packages/references', body)).status, 429);
    assert.equal((await post('/pills/search', body)).status, 429);
  } finally { server.close(); f.close(); }
});

test('Package scan uses only its local reader and cannot silently upload to Gemini', async () => {
  let cloud = 0, pills = 0;
  await assert.rejects(readMedicationScan('package', [{ name: 'box.png', data: 'data:image/png;base64,AAAA' }], 'not-used',
    { target: 'label', signal: signal(), onProgress: () => {} }, {
      local: async () => [], gemini: async () => { cloud++; return []; },
      vision: async () => { pills++; throw new Error('wrong gallery'); }, package: async () => { throw new Error('package unavailable'); },
    }), /package unavailable/);
  assert.equal(cloud, 0); assert.equal(pills, 0);
});
