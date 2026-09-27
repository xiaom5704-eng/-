import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import express from 'express';
import sharp from 'sharp';
import { openDrugDatabase, getTfda } from '../server/medications/store';
import { PersonalPillReferences } from '../server/vision/personal-pills';
import { personalPillRouter } from '../server/vision/personal-pill-router';
import { VisionService } from '../server/vision/service';
import { visionRouter } from '../server/vision/router';
import { pillReferenceIdentity } from '../shared/pill-references';
import { DIMENSIONS, MODEL_VERSION } from '../server/vision/config.mjs';
import { listenForFetch } from './http-listener';

const signal = () => new AbortController().signal;
const vector = (axis = 0) => { const out = new Float32Array(DIMENSIONS); out[axis] = 1; return out; };
const photo = () => sharp({ create: { width: 80, height: 60, channels: 3, background: '#286842' } }).png().toBuffer();
function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'medsafe-personal-pills-'));
  const personal = path.join(root, 'personal'), models = path.join(root, 'models');
  const official = path.join(root, 'official.db'), images = path.join(root, 'images');
  mkdirSync(path.join(models, 'onnx'), { recursive: true }); mkdirSync(images);
  writeFileSync(path.join(models, 'onnx/model_quantized.onnx'), 'synthetic');
  const drugs = openDrugDatabase(':memory:');
  for (const id of ['A', 'B']) {
    const drug = { source: 'tfda', id, name: '相同測試品名錠', englishName: 'Synthetic', ingredients: [`ingredient-${id}`], dosageForm: '錠劑', manufacturer: 'Synthetic maker' };
    drugs.prepare('INSERT INTO tfda_drugs VALUES(?,?,?,?,?,?)').run(id, drug.name, drug.englishName, id, 1, JSON.stringify(drug));
    const appearance = { shape: '圓形', color: '白', score: '', size: '', imprint1: '', imprint2: '', imageUrls: [`https://example.test/${id}.webp`], sourceUrl: '' };
    drugs.prepare('INSERT INTO tfda_appearances VALUES(?,?,?,?,?)').run(id, drug.name, drug.englishName, id, JSON.stringify(appearance));
  }
  const identity = (id = 'A') => pillReferenceIdentity(getTfda(drugs, id)!);
  const store = (embed = async () => vector()) => new PersonalPillReferences(drugs, personal, embed);
  const service = (refs: PersonalPillReferences, embed = async (_bytes: Buffer) => vector()) => new VisionService(drugs, official, images, models, embed, 'pill', refs);
  const officialReference = () => {
    const db = new Database(official), sha = 'a'.repeat(64);
    db.exec('CREATE TABLE metadata(key TEXT,value TEXT); CREATE TABLE images(key TEXT,drug_id TEXT,source_url TEXT,sha256 TEXT,model TEXT,embedding BLOB)');
    db.prepare('INSERT INTO metadata VALUES(?,?)').run('index', JSON.stringify({ state: 'ready', modelVersion: MODEL_VERSION, indexedAt: 'fixture' }));
    db.prepare('INSERT INTO images VALUES(?,?,?,?,?,?)').run('official:A', 'A', 'https://example.test/A.webp', sha, MODEL_VERSION, Buffer.from(vector(1).buffer));
    db.close(); writeFileSync(path.join(images, `${sha}.webp`), 'synthetic');
  };
  return { root, drugs, personal, models, images, official, identity, store, service, officialReference,
    close() { drugs.close(); assert.equal(path.dirname(root), os.tmpdir()); rmSync(root, { recursive: true, force: true }); } };
}

test('Personal references bind one reviewed license, deduplicate, strip metadata and preserve canonical ingredients', async () => {
  const f = fixture(); try {
    const store = f.store(), bytes = await sharp(await photo()).withExif({ IFD0: { Artist: 'SYNTHETIC PRIVATE METADATA' } }).jpeg().toBuffer();
    for (let i = 0; i < 2; i++) await store.register([bytes], 'A', f.identity(), '自行拍攝並核對', signal());
    assert.equal(store.snapshot().library.photos.length, 1);
    const result = await f.service(store).search([bytes], '', signal());
    assert.deepEqual(result.candidates.map(c => c.drug.id), ['A'], 'same-name B must not be inferred');
    assert.deepEqual(result.candidates[0].drug.ingredients, ['ingredient-A']);
    assert.equal(result.candidates[0].images[0].provenance, 'personal');
    assert.equal(result.status.personalImageCount, 1);
    const ref = store.snapshot().references[0], file = store.imagePath(ref.sha)!;
    assert.equal((await sharp(readFileSync(file)).metadata()).exif, undefined);
    assert.equal(store.imagePath('../outside'), null);
  } finally { f.close(); }
});

test('Official and personal references are ranked together for two different views, without lowering thresholds', async () => {
  const f = fixture(); try {
    f.officialReference(); const officialBefore = readFileSync(f.official), store = f.store();
    await store.register([await photo()], 'A', f.identity(), 'synthetic source', signal());
    const result = await f.service(store, async bytes => vector(bytes[0])).search([Buffer.from([0]), Buffer.from([1])], '', signal());
    assert.equal(result.candidates[0].drug.id, 'A'); assert.equal(result.candidates[0].images.length, 2);
    assert.equal(result.status.imageCount, 2); assert.equal(result.status.drugCount, 1);
    assert.equal(result.candidates[0].similarity, 1);
    assert.equal((await f.service(store, async () => vector(2)).search([await photo()], '', signal())).outcome, 'low_similarity');
    assert.deepEqual(readFileSync(f.official), officialBefore, 'personal collection must not alter the official index');
  } finally { f.close(); }
});

test('Stale identity, unknown products, non-pill forms and corrupt photos cannot be registered', async () => {
  const f = fixture(); try {
    const store = f.store(), bytes = await photo();
    await assert.rejects(store.register([bytes], 'B', f.identity('A'), 'source', signal()), /重新搜尋/);
    await assert.rejects(store.register([bytes], 'missing', f.identity(), 'source', signal()), /請先搜尋/);
    const identity = f.identity();
    f.drugs.prepare("UPDATE tfda_drugs SET payload=json_set(payload, '$.dosageForm', '注射劑') WHERE id='A'").run();
    await assert.rejects(store.register([bytes], 'A', identity, 'source', signal()), /請先搜尋/);
    await assert.rejects(store.register([Buffer.from('invalid')], 'B', f.identity('B'), 'source', signal()));
    assert.equal(existsSync(path.join(f.personal, 'index.db')), false);
  } finally { f.close(); }
});

test('Canonical updates during inference and cancellation leave no newly indexed photos', async () => {
  const f = fixture(); try {
    const bytes = await photo(), identity = f.identity(), controller = new AbortController();
    const cancel = f.store(async () => { controller.abort(); return vector(); });
    await assert.rejects(cancel.register([bytes], 'A', identity, 'source', controller.signal), { name: 'AbortError' });
    const changed = f.store(async () => { f.drugs.prepare("UPDATE tfda_drugs SET payload=json_set(payload, '$.ingredients', json('[\"changed\"]')) WHERE id='A'").run(); return vector(); });
    await assert.rejects(changed.register([bytes], 'A', identity, 'source', signal()), /重新搜尋/);
    assert.equal(existsSync(path.join(f.personal, 'index.db')), false);
  } finally { f.close(); }
});

test('Failure on a second photo preserves existing references and cannot partially register the first', async () => {
  const f = fixture(); try {
    const bytes = await photo(), store = f.store();
    await store.register([bytes], 'A', f.identity(), 'initial', signal());
    const prior = store.snapshot().library;
    let calls = 0; const failing = f.store(async () => ++calls === 2 ? new Float32Array(DIMENSIONS) : vector());
    await assert.rejects(failing.register([bytes, bytes], 'B', f.identity('B'), 'new', signal()), /特徵格式/);
    assert.deepEqual(store.snapshot().library, prior);
  } finally { f.close(); }
});

test('Disabled, stale, corrupt or missing references are excluded; restored files and explicit re-collection recover', async () => {
  const f = fixture(); try {
    const store = f.store(), bytes = await photo();
    await store.register([bytes], 'A', f.identity(), 'source', signal());
    const { sha } = store.snapshot().references[0], key = store.snapshot().library.photos[0].key, file = store.imagePath(sha)!;
    const saved = readFileSync(file);
    store.disable(key); assert.equal(store.snapshot().references.length, 0); assert.equal(store.imagePath(sha), null);
    await store.register([bytes], 'A', f.identity(), 'rechecked', signal()); assert.equal(store.snapshot().references.length, 1);
    writeFileSync(file, 'corrupt'); assert.equal(store.snapshot().references.length, 0);
    writeFileSync(file, saved); assert.equal(store.snapshot().references.length, 1);
    rmSync(file); assert.equal(store.snapshot().references.length, 0);
    writeFileSync(file, saved); assert.equal(store.snapshot().references.length, 1);
    f.drugs.prepare("UPDATE tfda_drugs SET payload=json_set(payload, '$.manufacturer', 'Changed') WHERE id='A'").run();
    assert.equal(store.snapshot().references.length, 0); assert.match(store.snapshot().library.photos[0].reason!, /品項資料/);
    await store.register([bytes], 'A', f.identity(), 'new identity rechecked', signal()); assert.equal(store.snapshot().references.length, 1);
    const index = new Database(path.join(f.personal, 'index.db'));
    index.prepare('UPDATE personal_pill_images SET model=?').run('old-model'); index.close();
    assert.equal(store.snapshot().references.length, 0); assert.match(store.snapshot().library.photos[0].reason!, /模型版本/);
    assert.equal(store.snapshot().library.photos[0].disabled, false);
    store.disable(key); assert.equal(store.snapshot().library.photos[0].disabled, true, 'an unusable old reference can still be explicitly disabled');
  } finally { f.close(); }
});

test('An unavailable personal database does not block official search; invalid official index cannot leak cached references', async () => {
  const f = fixture(); try {
    f.officialReference(); const store = f.store(), service = f.service(store, async () => vector(1));
    await store.register([await photo()], 'A', f.identity(), 'source', signal());
    assert.equal(service.status().imageCount, 2);
    writeFileSync(path.join(f.personal, 'index.db'), 'invalid SQLite');
    assert.equal(service.status().imageCount, 1); assert.match(service.status().personalWarning!, /無法讀取/);
    assert.equal((await service.search([await photo()], '', signal())).candidates[0].drug.id, 'A');
    writeFileSync(f.official, 'invalid SQLite');
    assert.equal(service.status().ready, false);
    assert.equal(service.imagePath('a'.repeat(64)), null);
  } finally { f.close(); }
});

test('Disable during query inference excludes the photo, including when official references remain usable', async () => {
  const f = fixture(); try {
    f.officialReference(); const store = f.store(), bytes = await photo();
    await store.register([bytes], 'A', f.identity(), 'source', signal());
    const key = store.snapshot().library.photos[0].key;
    const result = await f.service(store, async () => { store.disable(key); return vector(); }).search([bytes], '', signal());
    assert.equal(result.outcome, 'low_similarity'); assert.equal(result.status.personalImageCount, 0);
  } finally { f.close(); }
});

test('Personal photo API requires explicit confirmation, shares the queue and stops serving disabled images', async () => {
  const f = fixture(); const store = f.store(), service = f.service(store), queue = { busy: false };
  const app = express(); app.use(express.json()); app.use(personalPillRouter(store, service, queue)); app.use(visionRouter(service, queue));
  const server = await listenForFetch(app), base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const post = (url: string, body: unknown) => fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const body = { images: [`data:image/png;base64,${(await photo()).toString('base64')}`], drugId: 'A', identity: f.identity(), sourceNote: 'source', confirmed: true };
  try {
    assert.equal((await post('/personal-references', { ...body, confirmed: false })).status, 400);
    queue.busy = true; assert.equal((await post('/personal-references', body)).status, 429); queue.busy = false;
    assert.equal((await post('/personal-references', { ...body, identity: 'forged' })).status, 422);
    const added = await post('/personal-references', body); assert.equal(added.status, 200);
    const ref = store.snapshot().references[0], photoPath = `/personal-images/${ref.sha}.webp`;
    const image = await fetch(base + photoPath); assert.equal(image.status, 200); assert.equal(image.headers.get('cache-control'), 'private, no-store'); await image.arrayBuffer();
    const library = await (await fetch(base + '/personal-references')).json();
    assert.equal(library.photos.length, 1);
    assert.equal((await post(`/personal-references/${library.photos[0].key}/disable`, {})).status, 200);
    assert.equal((await fetch(base + photoPath)).status, 404);
    assert.equal((await post('/search', body)).status, 503);
  } finally { server.close(); f.close(); }
});
