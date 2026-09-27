import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import { openDrugDatabase, findDdinter, type DrugDatabase } from '../server/medications/store';
import { ddinterDrugUrl, ddinterGraphUrl, importDdinterGraph } from '../server/medications/ddinter-supplements';
import { applyReviewedDdinter, applyReviewedDdinterFile, parseReviewedDdinter } from '../scripts/reviewed-ddinter';
import { DrugProviders } from '../server/medications/providers';
import type { DrugCandidate } from '../shared/medication';

const date = '2026-09-27T00:00:00.000Z';
const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
function fixture(t: TestContext, filename = ':memory:') {
  const db = openDrugDatabase(filename); t.after(() => db.close());
  db.prepare('INSERT INTO tfda_drugs VALUES(?,?,?,?,?,?)').run('synthetic', 'Synthetic', 'Synthetic', '', 1, '{}');
  db.prepare('INSERT INTO ddinter_drugs VALUES(?,?,?)').run('DDInter90001', 'Seed A', 'seed a');
  db.prepare('INSERT INTO ddinter_drugs VALUES(?,?,?)').run('DDInter90002', 'Seed B', 'seed b');
  db.prepare('INSERT INTO ddinter_pairs VALUES(?,?,?)').run('DDInter90001', 'DDInter90002', 'Unknown');
  return db;
}
function archive(id = 'DDInter1', name = 'Alpha', level = 'Moderate', partner = 'DDInter2') {
  const raw = JSON.stringify({ info: { id, Name: name }, interactions: partner ? [{ id: partner, name: 'Beta', level: [level], actions: ['synergy'] }] : [] });
  return { schema: 1, id, name, retrievedAt: date, sourceUrl: ddinterDrugUrl(id), dataUrl: ddinterGraphUrl(id), sha256: hash(raw), raw };
}
function bundle(archives = [archive()]) {
  return { schema: 1, id: 'ddinter-missing-ingredients-2026-09-27', license: 'CC BY-NC-SA 4.0',
    attribution: 'Synthetic tests only', termsUrl: 'https://ddinter2.scbdd.com/terms/', archives };
}
function apply(db: DrugDatabase, value: ReturnType<typeof bundle>) {
  const bytes = Buffer.from(JSON.stringify(value)); return applyReviewedDdinter(db, bytes, hash(bytes));
}

test('Published supplement is pinned, retains source provenance and is repeatable entirely offline', async t => {
  const db = fixture(t), bytes = await readFile(new URL('../resources/ddinter/missing-ingredients-2026-09-27.json', import.meta.url));
  assert.equal(parseReviewedDdinter(bytes).length, 44);
  const result = applyReviewedDdinter(db, bytes);
  assert.equal(result.addedSnapshots, 44);
  assert.equal(findDdinter(db, 'Povidone-iodine'), 'DDInter2256');
  assert.deepEqual(db.prepare("SELECT drug_a,drug_b,level FROM ddinter_all_pairs WHERE drug_a='DDInter2256' AND drug_b='DDInter250'").get(),
    { drug_a: 'DDInter2256', drug_b: 'DDInter250', level: 'Minor' });
  const rows = db.prepare('SELECT * FROM ddinter_web_snapshots ORDER BY id').all();
  const repeat = applyReviewedDdinter(db, bytes);
  assert.equal(repeat.addedSnapshots, 0); assert.equal(repeat.alreadyPresent, 44); assert.equal(repeat.addedPairs, 0);
  assert.deepEqual(db.prepare('SELECT * FROM ddinter_web_snapshots ORDER BY id').all(), rows);
  assert.deepEqual(db.prepare('SELECT level FROM ddinter_pairs').get(), { level: 'Unknown' });
});

test('Bad checksum, archive hash, URL, date, name, ID or duplicate rejects the entire bundle before writes', t => {
  const db = fixture(t), original = bundle();
  const bytes = Buffer.from(JSON.stringify(original));
  assert.throws(() => applyReviewedDdinter(db, bytes), /SHA-256/);
  const damages = [
    (v: typeof original) => { v.archives[0].raw += ' '; },
    (v: typeof original) => { v.archives[0].dataUrl = 'https://example.invalid/'; },
    (v: typeof original) => { v.archives[0].sourceUrl = 'https://example.invalid/'; },
    (v: typeof original) => { v.archives[0].retrievedAt = 'not a date'; },
    (v: typeof original) => { v.archives[0].name = 'Different'; },
    (v: typeof original) => { v.archives[0].id = 'DDInter4'; },
    (v: typeof original) => { v.archives.push(v.archives[0]); },
  ];
  for (const damage of damages) { const value = structuredClone(original); damage(value); assert.throws(() => apply(db, value)); }
  assert.equal(db.prepare('SELECT * FROM ddinter_web_snapshots').all().length, 0);
  assert.equal(db.prepare('SELECT * FROM ddinter_all_pairs').all().length, 1);
});

test('A later graph conflict rolls back all earlier imports, preserving the original pair and source', t => {
  const db = fixture(t), initial = archive();
  importDdinterGraph(db, initial.raw, initial.id, date);
  const before = db.prepare('SELECT * FROM ddinter_web_snapshots').all();
  const first = archive('DDInter3', 'Gamma', 'Minor');
  const conflict = archive('DDInter2', 'Beta', 'Major', 'DDInter1');
  const raw = JSON.parse(conflict.raw); raw.interactions[0].name = 'Alpha';
  conflict.raw = JSON.stringify(raw); conflict.sha256 = hash(conflict.raw);
  assert.throws(() => apply(db, bundle([first, conflict])), /衝突/);
  assert.deepEqual(db.prepare('SELECT * FROM ddinter_web_snapshots').all(), before);
  assert.equal(findDdinter(db, 'Gamma'), undefined);
});

test('Neither same-content acquisition dates nor different locally acquired graphs are overwritten', t => {
  const db = fixture(t), first = archive(), second = archive('DDInter3', 'Gamma', 'Minor');
  importDdinterGraph(db, first.raw, first.id, '2026-09-26T00:00:00.000Z');
  importDdinterGraph(db, second.raw, second.id, '2026-09-28T00:00:00.000Z');
  const before = db.prepare('SELECT * FROM ddinter_web_snapshots ORDER BY id').all();
  const result = apply(db, bundle([first, archive('DDInter3', 'Gamma', 'Major')]));
  assert.equal(result.alreadyPresent, 1); assert.equal(result.preservedExisting, 1); assert.equal(result.addedPairs, 0);
  assert.deepEqual(db.prepare('SELECT * FROM ddinter_web_snapshots ORDER BY id').all(), before);
});

test('A zero-pair official snapshot maps the name but leaves the interaction unproven', async t => {
  const db = fixture(t); apply(db, bundle([archive('DDInter3', 'Gamma', 'Minor', '')]));
  const provider = new DrugProviders(db, async () => assert.fail('network forbidden'));
  const product = (name: string): DrugCandidate => ({ source: 'tfda', id: name, name, englishName: name, ingredients: [name], dosageForm: '',
    manufacturer: '', licenseStatus: '', validUntil: '', indications: '', dosageText: '', sourceUrl: 'https://data.gov.tw/dataset/9122' });
  const report = await provider.report([product('Gamma'), product('Seed A')], 'local');
  assert.equal(report.medications[0].ingredients[0].ddinterId, 'DDInter3');
  assert.equal(report.interactions[0].status, 'not_found');
});

test('File application refuses absent or empty base data without creating a database', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'medsafe-reviewed-'));
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('medsafe-reviewed-'));
    await rm(root, { recursive: true, force: true });
  });
  const filename = path.join(root, 'missing.db');
  await assert.rejects(applyReviewedDdinterFile(filename));
  assert.deepEqual(await readdir(root), []);
  const db = new Database(filename);
  db.close();
  await assert.rejects(applyReviewedDdinterFile(filename), /基本資料/);
  const check = new Database(filename);
  try { assert.deepEqual(check.prepare('SELECT name FROM sqlite_master').all(), []); } finally { check.close(); }
});
