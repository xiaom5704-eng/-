import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { appearanceTerms, openDrugDatabase } from '../server/medications/store';
import { VisionService } from '../server/vision/service';
import { DIMENSIONS, MODEL_VERSION } from '../server/vision/config.mjs';
import type { DrugCandidate } from '../shared/medication';
import { rankVisualReferences } from '../shared/medication-vision';

const vector = (x: number, y = Math.sqrt(1 - x * x)) => {
  const value = new Float32Array(DIMENSIONS); value[0] = x; value[1] = y; return value;
};
function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'medsafe-imprint-'));
  const imageRoot = path.join(root, 'images'), modelRoot = path.join(root, 'models'), indexPath = path.join(root, 'index.db');
  mkdirSync(imageRoot); mkdirSync(path.join(modelRoot, 'onnx'), { recursive: true });
  writeFileSync(path.join(modelRoot, 'onnx/model_quantized.onnx'), 'synthetic');
  const db = openDrugDatabase(':memory:'), index = new Database(indexPath);
  index.exec('CREATE TABLE metadata(key TEXT,value TEXT); CREATE TABLE images(key TEXT,drug_id TEXT,source_url TEXT,sha256 TEXT,model TEXT,embedding BLOB);');
  index.prepare('INSERT INTO metadata VALUES (?,?)').run('index', JSON.stringify({ state: 'ready', modelVersion: MODEL_VERSION, indexedAt: 'synthetic' }));
  let sequence = 0;
  const add = (id: string, imprint: string, ref?: Float32Array, form = '錠劑', stale = false) => {
    const drug: DrugCandidate = { source: 'tfda', id, name: `人工測試 ${id}`, englishName: '', ingredients: [`Ingredient ${id}`],
      dosageForm: form, manufacturer: '', licenseStatus: '', validUntil: '', indications: '', dosageText: '', sourceUrl: 'https://example.test' };
    const sourceUrl = `https://example.test/${id}.webp`;
    const appearance = { shape: '圓形', color: '白', score: '', size: '', imprint1: imprint, imprint2: '', imageUrls: [sourceUrl], sourceUrl: 'https://example.test' };
    db.prepare('INSERT INTO tfda_drugs VALUES (?,?,?,?,?,?)').run(id, drug.name, '', id, 1, JSON.stringify(drug));
    db.prepare('INSERT INTO tfda_appearances VALUES (?,?,?,?,?)').run(id, drug.name, '', id, JSON.stringify(appearance));
    for (const mark of appearanceTerms(imprint, 'imprint')) db.prepare('INSERT INTO tfda_appearance_terms VALUES (?,?,?)').run(id, 'imprint', mark);
    if (ref) {
      const sha = (++sequence).toString(16).padStart(64, '0');
      writeFileSync(path.join(imageRoot, `${sha}.webp`), 'synthetic');
      index.prepare('INSERT INTO images VALUES (?,?,?,?,?,?)').run(id, id, stale ? sourceUrl + '?old' : sourceUrl, sha, MODEL_VERSION, Buffer.from(ref.buffer));
    }
  };
  add('VISUAL', 'OTHER', vector(1));
  return { db, add, service: new VisionService(db, indexPath, imageRoot, modelRoot, async bytes => bytes[0] === 2 ? vector(0) : vector(1)),
    close() { index.close(); db.close(); rmSync(root, { recursive: true, force: true }); } };
}
const search = (f: ReturnType<typeof fixture>, imprint = '', twoViews = false) =>
  f.service.search(twoViews ? [Buffer.from([1]), Buffer.from([2])] : [Buffer.from([1])], imprint, new AbortController().signal);

test('Exact imprint rescues low-similarity and unindexed products without labelling them image matches', async () => {
  const f = fixture();
  try {
    f.add('LOW', 'FC 10', vector(0)); f.add('NO-IMAGE', 'FC10'); f.add('STALE', 'FC10', vector(1), '錠劑', true);
    f.add('LIQUID', 'FC10', undefined, '內服液劑'); f.add('LOOKALIKE', 'FC1O', vector(0));
    const pure = await search(f);
    assert.deepEqual(pure.candidates.map(item => item.drug.id), ['VISUAL']);
    assert.equal(pure.imprintSearch, undefined);
    const result = await search(f, 'ｆｃ １０');
    assert.deepEqual(result.imprintSearch, { input: 'ｆｃ １０', total: 3, shown: 3 });
    assert.equal(result.candidates[0].drug.id, 'LOW');
    for (const id of ['LOW', 'NO-IMAGE', 'STALE']) {
      const item = result.candidates.find(item => item.drug.id === id)!;
      assert.equal(item.matchedBy, 'imprint'); assert.equal(item.imprint, 'match');
      assert.deepEqual(item.drug.ingredients, [`Ingredient ${id}`]);
      assert.equal(item.similarity, id === 'LOW' ? 0 : null);
    }
    assert.equal(result.candidates.some(item => ['LIQUID', 'LOOKALIKE'].includes(item.drug.id)), false);
    assert.equal((await search(f, 'FC')).imprintSearch?.total, 0, 'substring is not a complete-side imprint');
    assert.equal((await search(f, 'FC10;;;OTHER')).imprintSearch?.total, 0, 'a query cannot silently merge unrelated imprints');
    assert.deepEqual((await search(f)).candidates, pure.candidates, 'imprint search does not change later pure CV retrieval');
  } finally { f.close(); }
});

test('One passing photo cannot disguise a conflicting second view as a visual match', async () => {
  const f = fixture();
  try {
    const one = await search(f, 'OTHER');
    assert.equal(one.candidates[0].matchedBy, 'image_and_imprint');
    assert.equal((await search(f, '', true)).outcome, 'low_similarity');
    const two = await search(f, 'OTHER', true);
    assert.equal(two.candidates[0].matchedBy, 'imprint');
    assert.equal(two.candidates[0].similarity, 0.5);
    assert.match(two.warnings.join(' '), /勿混入不同藥品/);
  } finally { f.close(); }
});

test('Shared imprints expose total counts and recheck canonical appearance instead of trusting stale terms', async () => {
  const f = fixture();
  try {
    for (let i = 0; i < 25; i++) f.add(`SAME-${String(i).padStart(2, '0')}`, 'AB');
    const first = await search(f, 'AB');
    assert.deepEqual(first.imprintSearch, { input: 'AB', total: 25, shown: 8 });
    assert.equal(first.candidates.length, 8);
    assert.ok(first.candidates.every(item => item.matchedBy === 'imprint' && item.similarity === null));
    assert.match(first.warnings.join(' '), /25 個藥錠品項/);
    f.db.prepare("UPDATE tfda_appearances SET payload=json_set(payload,'$.imprint1','DIFFERENT') WHERE id='SAME-00'").run();
    f.db.prepare("UPDATE tfda_drugs SET payload=json_set(payload,'$.dosageForm','注射劑') WHERE id='SAME-01'").run();
    f.db.prepare("DELETE FROM tfda_drugs WHERE id='SAME-02'").run();
    f.db.prepare("DELETE FROM tfda_appearances WHERE id='SAME-02'").run();
    const second = await search(f, 'AB');
    assert.equal(second.imprintSearch?.total, 22);
    assert.ok(second.candidates.every(item => !['SAME-00', 'SAME-01', 'SAME-02'].includes(item.drug.id)));
  } finally { f.close(); }
});

test('An opposite reference vector retains its key when used only as imprint evidence', () => {
  const ranked = rankVisualReferences([vector(1)], [{ key: 'opposite', drugId: 'A', vector: vector(-1, 0) }], 8, -1);
  assert.equal(ranked[0].views[0].key, 'opposite'); assert.equal(ranked[0].similarity, -1);
});
