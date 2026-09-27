import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { VisionIndexBuild, saveVerifiedImage } from '../scripts/vision-index-build.mjs';
import { VisionService } from '../server/vision/service';
import { MODEL_VERSION, DIMENSIONS } from '../server/vision/config.mjs';
import { openDrugDatabase } from '../server/medications/store';

const hash = (input: string | Buffer) => createHash('sha256').update(input).digest('hex');
const vector = (offset = 0) => { const result = new Float32Array(DIMENSIONS); result[offset] = 1; return Buffer.from(result.buffer); };
const record = (id: string) => ({ key: hash(id), id, src: `https://example.test/${id}.webp`, sha: hash(`image-${id}`) });
function setup() {
  const db = new Database(':memory:'), initial = new VisionIndexBuild(db, MODEL_VERSION, DIMENSIONS), row = record('OLD');
  initial.stage(row, vector()); initial.publish({ sourceVersion: 'test-old' }, [row]);
  return { db, row, snapshot: () => ({ metadata: db.prepare('SELECT * FROM metadata').all(), images: db.prepare('SELECT * FROM images').all() }) };
}
function removeTemporary(root: string) {
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(root).startsWith('medsafe-index-build-'));
  rmSync(root, { recursive: true, force: true });
}

test('Live vision readers keep the published image across interruption, resume, and complete publication', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'medsafe-index-build-'));
  const file = path.join(root, 'index.db'), imageRoot = path.join(root, 'images'), modelRoot = path.join(root, 'models');
  mkdirSync(imageRoot); mkdirSync(path.join(modelRoot, 'onnx'), { recursive: true }); writeFileSync(path.join(modelRoot, 'onnx/model_quantized.onnx'), 'synthetic');
  const drugs = openDrugDatabase(':memory:'); let db = new Database(file);
  const old = record('OLD'), next = record('NEXT');
  try {
    for (const row of [old, next]) {
      const drug = { id: row.id, source: 'tfda', name: row.id, englishName: row.id, ingredients: [], dosageForm: '錠劑' };
      drugs.prepare('INSERT INTO tfda_drugs VALUES (?,?,?,?,?,?)').run(row.id, row.id, row.id, row.id, 1, JSON.stringify(drug));
      drugs.prepare('INSERT INTO tfda_appearances VALUES (?,?,?,?,?)').run(row.id, row.id, row.id, row.id, JSON.stringify({ imageUrls: [row.src] }));
      writeFileSync(path.join(imageRoot, `${row.sha}.webp`), `image-${row.id}`);
    }
    const initial = new VisionIndexBuild(db, MODEL_VERSION, DIMENSIONS); initial.stage(old, vector()); initial.publish({}, [old]);
    const service = new VisionService(drugs, file, imageRoot, modelRoot, async () => { const result = new Float32Array(DIMENSIONS); result[0] = 1; return result; });
    const query = async () => service.search([Buffer.from('test')], '', new AbortController().signal);
    const build = new VisionIndexBuild(db, MODEL_VERSION, DIMENSIONS); build.stage(next, vector());
    assert.equal(service.status().ready, true); assert.equal(service.status().imageCount, 1);
    assert.ok(service.imagePath(old.sha)); assert.equal(service.imagePath(next.sha), null);
    db.close(); db = new Database(file);
    const resumed = new VisionIndexBuild(db, MODEL_VERSION, DIMENSIONS);
    assert.deepEqual(resumed.reusable(next), vector()); assert.ok(service.imagePath(old.sha));
    resumed.stage(next, resumed.reusable(next)); resumed.publish({}, [next]);
    assert.equal(service.status().ready, true); assert.equal(service.imagePath(old.sha), null); assert.ok(service.imagePath(next.sha));
    assert.equal((await query()).candidates[0].drug.id, next.id);
  } finally { db.close(); drugs.close(); removeTemporary(root); }
});

test('Incomplete, corrupted or failed publication preserves every published row and metadata', () => {
  const { db, snapshot } = setup(); const before = snapshot(), next = record('NEXT'), other = record('OTHER');
  try {
    const build = new VisionIndexBuild(db, MODEL_VERSION, DIMENSIONS); build.stage(next, vector());
    assert.throws(() => build.publish({}, [next, other]), /尚未全部/); assert.deepEqual(snapshot(), before);
    db.prepare('UPDATE image_build_cache SET embedding=?').run(Buffer.from('corrupt'));
    assert.throws(() => build.publish({}, [next]), /不完整/); assert.deepEqual(snapshot(), before);
    build.stage(next, vector());
    db.exec("CREATE TRIGGER reject_publication BEFORE INSERT ON images BEGIN SELECT RAISE(ABORT, 'synthetic disk error'); END");
    assert.throws(() => build.publish({}, [next]), /synthetic disk error/); assert.deepEqual(snapshot(), before);
    db.exec('DROP TRIGGER reject_publication'); build.publish({}, [next]);
    assert.equal((db.prepare('SELECT drug_id FROM images').get() as { drug_id: string }).drug_id, next.id);
  } finally { db.close(); }
});

test('A stale concurrent builder cannot overwrite another completed publication', () => {
  const { db, snapshot } = setup();
  try {
    const first = new VisionIndexBuild(db, MODEL_VERSION, DIMENSIONS), second = new VisionIndexBuild(db, MODEL_VERSION, DIMENSIONS);
    const a = record('A'), b = record('B'); first.stage(a, vector()); second.stage(b, vector());
    first.publish({}, [a]); const published = snapshot();
    assert.throws(() => second.publish({}, [b]), /另一個程序/); assert.deepEqual(snapshot(), published);
  } finally { db.close(); }
});

test('Resume rejects corrupt vectors and changed source, dimensions, identity or model', () => {
  const { db, row } = setup();
  try {
    const build = new VisionIndexBuild(db, MODEL_VERSION, DIMENSIONS);
    assert.deepEqual(build.reusable(row), vector());
    for (const changed of [{ ...row, id: 'different' }, { ...row, src: 'https://example.test/changed' }, { ...row, sha: 'a'.repeat(64) }]) assert.equal(build.reusable(changed), null);
    assert.equal(new VisionIndexBuild(db, 'changed-model', DIMENSIONS).reusable(row), null);
    assert.equal(new VisionIndexBuild(db, MODEL_VERSION, 1).reusable(row), null);
    for (const bytes of [Buffer.alloc(DIMENSIONS * 4), Buffer.from('short'), Buffer.from(new Float32Array(DIMENSIONS).fill(NaN).buffer)]) {
      assert.throws(() => build.stage(row, bytes), /特徵格式/);
      db.prepare('UPDATE images SET embedding=?').run(bytes); assert.equal(build.reusable(row), null);
    }
  } finally { db.close(); }
});

test('Image publication preserves valid files, repairs corrupt bytes and rejects bad content before writing', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'medsafe-index-build-'));
  try {
    const bytes = Buffer.from('verified image bytes'), sha = hash(bytes), file = path.join(root, `${sha}.webp`);
    await saveVerifiedImage(root, sha, bytes); const modified = statSync(file).mtimeMs;
    await saveVerifiedImage(root, sha, bytes); assert.equal(statSync(file).mtimeMs, modified);
    await assert.rejects(saveVerifiedImage(root, sha, Buffer.from('different')), /雜湊/); assert.deepEqual(readFileSync(file), bytes);
    await assert.rejects(saveVerifiedImage(root, '../outside', bytes), /雜湊/);
    writeFileSync(file, 'broken'); await saveVerifiedImage(root, sha, bytes); assert.deepEqual(readFileSync(file), bytes);
    assert.deepEqual(readdirSync(root), [`${sha}.webp`]);
  } finally { removeTemporary(root); }
});
