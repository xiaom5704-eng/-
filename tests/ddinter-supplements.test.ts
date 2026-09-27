import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDrugDatabase, datasetStatus, findDdinter, type DrugDatabase } from '../server/medications/store';
import { importDdinter } from '../server/medications/importers';
import { ddinterDrugUrl, ddinterGraphUrl, importDdinterGraph, parseDdinterGraph } from '../server/medications/ddinter-supplements';
import { DrugProviders } from '../server/medications/providers';
import { ingredientRegistryKey, writeIngredientRecord } from '../server/medications/ingredient-registry';
import { reportToMarkdown, type DrugCandidate } from '../shared/medication';

// Synthetic names only; never imported into the application database.
const opened: DrugDatabase[] = [];
const db = () => { const value = openDrugDatabase(':memory:'); opened.push(value); return value; };
afterEach(() => opened.splice(0).forEach(value => value.close()));
const date = '2026-09-20T00:00:00.000Z';
const graph = (level = 'Moderate', root = 'DDInter1', name = 'Alpha') => JSON.stringify({ info: { id: root, Name: name },
  interactions: [{ id: 'DDInter2', name: 'Beta', level: [level], actions: ['synergy'] }] });
const csv = 'DDInterID_A,Drug_A,DDInterID_B,Drug_B,Level\nDDInter1,Alpha,DDInter2,Beta,Moderate\n';
const product = (name: string): DrugCandidate => ({ source: 'tfda', id: name, name, englishName: name, ingredients: [name],
  dosageForm: '', manufacturer: '', licenseStatus: '', validUntil: '', indications: '', dosageText: '', sourceUrl: 'https://data.gov.tw/dataset/9122' });

test('Website graph validates exact identity, complete levels, duplicate partners and sizes', () => {
  assert.equal(parseDdinterGraph(graph(), 'DDInter1').pairs.length, 1);
  for (const raw of ['null', '{', graph('Unsafe'), graph('Moderate', 'DDInter9'),
    JSON.stringify({ info: { id: 'DDInter1', Name: 'Alpha' }, interactions: [{ id: 'DDInter2', name: 'Beta', level: ['Major', 'Minor'] }] }),
    JSON.stringify({ info: { id: 'DDInter1', Name: 'Alpha' }, interactions: [{ id: 'DDInter1', name: 'Alpha', level: ['Major'] }] })])
    assert.throws(() => parseDdinterGraph(raw, 'DDInter1'));
  const repeated = JSON.parse(graph()); repeated.interactions.push(repeated.interactions[0]);
  assert.throws(() => parseDdinterGraph(JSON.stringify(repeated), 'DDInter1'));
  assert.throws(() => parseDdinterGraph(' '.repeat(4_000_001), 'DDInter1'));
});

test('Offline report resolves a website-only ingredient and preserves provenance in saved report', async () => {
  const database = db();
  importDdinterGraph(database, graph(), 'DDInter1', date);
  assert.equal(findDdinter(database, 'ALPHA'), 'DDInter1');
  const provider = new DrugProviders(database, async () => { throw Error('Unexpected external request'); });
  const report = await provider.report([product('Alpha'), product('Beta')], 'local');
  assert.equal(report.interactions[0].status, 'found');
  assert.equal(report.interactions[0].level, 'Moderate');
  assert.equal(report.interactions[0].sourceUrl, ddinterDrugUrl('DDInter1'));
  assert.deepEqual(report.interactions[0].websiteSnapshot, { retrievedAt: date, dataUrl: ddinterGraphUrl('DDInter1') });
  assert.equal(report.datasets.find(s => s.source === 'ddinter')!.count, 1);
  assert.match(reportToMarkdown(report), /官方網站配對快照/);
  assert.ok(reportToMarkdown(report).includes('取得時間：2026\\-09\\-20T00:00:00\\.000Z'));
});

test('CSV overlap and reciprocal graphs count one pair, retain CSV and reject conflicting updates atomically', () => {
  const database = db();
  importDdinter(database, [{ name: 'synthetic.csv', csv }], date);
  importDdinterGraph(database, graph(), 'DDInter1', date);
  const reverse = JSON.stringify({ info: { id: 'DDInter2', Name: 'Beta' }, interactions: [{ id: 'DDInter1', name: 'Alpha', level: ['Moderate'] }] });
  importDdinterGraph(database, reverse, 'DDInter2', date);
  assert.equal(datasetStatus(database).find(s => s.source === 'ddinter')!.count, 1);
  assert.throws(() => importDdinterGraph(database, graph('Major'), 'DDInter1', date), /衝突/);
  assert.throws(() => importDdinterGraph(database, graph('Moderate', 'DDInter1', 'Different'), 'DDInter1', date), /名稱不一致/);
  assert.throws(() => importDdinter(database, [{ name: 'new.csv', csv: csv.replace('Moderate', 'Minor') }], date), /衝突/);
  assert.equal((database.prepare('SELECT level FROM ddinter_pairs').get() as any).level, 'Moderate');
  assert.equal((database.prepare('SELECT raw FROM ddinter_web_snapshots WHERE id=?').get('DDInter1') as any).raw, graph());
});

test('Refreshing one graph removes obsolete website rows without deleting CSV or other graph evidence', () => {
  const database = db();
  importDdinter(database, [{ name: 'synthetic.csv', csv }], date);
  importDdinterGraph(database, graph(), 'DDInter1', date);
  const extra = JSON.stringify({ info: { id: 'DDInter3', Name: 'Gamma' }, interactions: [{ id: 'DDInter2', name: 'Beta', level: ['Minor'] }] });
  importDdinterGraph(database, extra, 'DDInter3', date);
  importDdinterGraph(database, JSON.stringify({ info: { id: 'DDInter3', Name: 'Gamma' }, interactions: [] }), 'DDInter3', date);
  assert.equal(database.prepare('SELECT * FROM ddinter_web_pairs WHERE root_id=?').all('DDInter3').length, 0);
  assert.equal(database.prepare('SELECT * FROM ddinter_web_pairs WHERE root_id=?').all('DDInter1').length, 1);
  assert.equal(datasetStatus(database).find(s => s.source === 'ddinter')!.count, 1);
  importDdinter(database, [{ name: 'synthetic.csv', csv }], date);
  assert.equal(database.prepare('SELECT * FROM ddinter_web_snapshots').all().length, 2);
});

test('Existing exact RxNorm salt relationships can connect to website names without relaxed name matching', async () => {
  const database = db();
  importDdinterGraph(database, graph(), 'DDInter1', date);
  writeIngredientRecord(database, ingredientRegistryKey(['Alpha salt']), { schema: 1, status: 'matched', checkedAt: date,
    version: 'synthetic', lookupUrl: 'https://rxnav.nlm.nih.gov/REST/rxcui.json?name=Alpha%20salt&search=0',
    matched: { name: 'Alpha salt', rxcui: '100', tty: 'PIN' }, ingredient: { name: 'Alpha', rxcui: '101', tty: 'IN' } });
  const provider = new DrugProviders(database, async () => { throw Error('Unexpected external request'); });
  assert.equal((await provider.resolveIngredient('Alpha salt', undefined, 'local'))[0].ddinterId, 'DDInter1');
  assert.equal((await provider.resolveIngredient('Alph', undefined, 'local'))[0].ddinterId, undefined);
});

test('Stored website snapshot survives database reopen and malformed refresh preserves raw response and date', () => {
  const folder = mkdtempSync(path.join(tmpdir(), 'ddinter-web-'));
  const file = path.join(folder, 'drugs.db');
  let database = openDrugDatabase(file);
  try {
    importDdinterGraph(database, graph(), 'DDInter1', date); database.close(); database = openDrugDatabase(file);
    assert.equal(findDdinter(database, 'Alpha'), 'DDInter1');
    assert.throws(() => importDdinterGraph(database, '{}', 'DDInter1', '2026-09-21T00:00:00Z'));
    assert.throws(() => importDdinterGraph(database, graph(), 'DDInter1', 'bad date'));
    assert.equal((database.prepare('SELECT retrieved_at FROM ddinter_web_snapshots').get() as any).retrieved_at, date);
  } finally {
    database.close();
    assert.equal(path.dirname(path.resolve(folder)), path.resolve(tmpdir()));
    assert.ok(path.basename(folder).startsWith('ddinter-web-'));
    rmSync(folder, { recursive: true, force: true });
  }
});
