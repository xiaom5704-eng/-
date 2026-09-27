import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { openDrugDatabase, type DrugDatabase } from '../server/medications/store';
import { importDdinter } from '../server/medications/importers';
import { importDdinterGraph } from '../server/medications/ddinter-supplements';
import { createDdinterMechanismReader } from '../server/medications/ddinter-mechanisms';
import { mechanismTypes, mechanismScope } from '../shared/interaction-mechanism';
import { DrugProviders } from '../server/medications/providers';
import { escapeMarkdown, reportToMarkdown, type DrugCandidate } from '../shared/medication';
import MedicationInteractions from '../src/components/MedicationInteractions';

// Synthetic pair identities; no test fixture is imported into application data.
const opened: DrugDatabase[] = [];
afterEach(() => opened.splice(0).forEach(db => db.close()));
const database = () => { const db = openDrugDatabase(':memory:'); opened.push(db); return db; };
const date = '2026-09-24T00:00:00.000Z';
const graph = (actions: unknown = ['synergy'], reverse = false, level = 'Moderate') => JSON.stringify({
  info: { id: reverse ? 'DDInter2' : 'DDInter1', Name: reverse ? 'Beta' : 'Alpha' },
  interactions: [{ id: reverse ? 'DDInter1' : 'DDInter2', name: reverse ? 'Alpha' : 'Beta', level: [level], actions }],
});
const put = (db: DrugDatabase, actions: unknown = ['synergy'], reverse = false, level = 'Moderate', timestamp = date) =>
  importDdinterGraph(db, graph(actions, reverse, level), reverse ? 'DDInter2' : 'DDInter1', timestamp);
const product = (name: string): DrugCandidate => ({ source: 'tfda', id: name, name, englishName: name, ingredients: [name],
  dosageForm: '', manufacturer: '', licenseStatus: '', validUntil: '', indications: '', dosageText: '', sourceUrl: 'https://data.gov.tw/dataset/9122' });

test('Mechanism categories accept only known complete arrays and preserve unknown as unknown', () => {
  assert.deepEqual(mechanismTypes(['metabolism', 'absorption']), ['absorption', 'metabolism']);
  assert.deepEqual(mechanismTypes(['unknown']), ['unknown']);
  for (const value of [undefined, null, [], 'synergy', ['synergy', 'synergy'], ['future'], ['absorption', 'future'], ['__proto__'], ['<script>'], [1]])
    assert.equal(mechanismTypes(value), undefined);
});

test('Exact source mechanism can supplement a CSV pair without changing its grade or provenance', async () => {
  const db = database();
  importDdinter(db, [{ name: 'synthetic.csv', csv: 'DDInterID_A,Drug_A,DDInterID_B,Drug_B,Level\nDDInter1,Alpha,DDInter2,Beta,Moderate\n' }], date);
  put(db, ['absorption', 'metabolism']); let external = 0;
  const provider = new DrugProviders(db, async () => { external++; throw Error('Unexpected request'); });
  const report = await provider.report([product('Alpha'), product('Beta')], 'local');
  assert.equal(external, 0);
  assert.equal(report.interactions[0].status, 'found'); assert.equal(report.interactions[0].level, 'Moderate');
  assert.equal(report.interactions[0].sourceUrl, 'https://ddinter2.scbdd.com/download/');
  assert.equal(report.interactions[0].websiteSnapshot, undefined);
  assert.deepEqual(report.interactions[0].mechanism?.types, ['absorption', 'metabolism']);
  assert.equal(report.interactions[0].mechanism?.sourceUrl, 'https://ddinter2.scbdd.com/server/drug-detail/DDInter1/');
  assert.equal(report.interactions[0].mechanism?.retrievedAt, date);
  assert.equal(createDdinterMechanismReader(db)('DDInter1', 'DDInter2', 'Major'), undefined);
  assert.equal(createDdinterMechanismReader(db)('DDInter1', 'DDInter3', 'Moderate'), undefined);
});

test('Reciprocal source disagreement or missing newer annotation does not inherit or merge older meaning', () => {
  const db = database(); put(db, ['synergy', 'metabolism']); put(db, ['metabolism', 'synergy'], true);
  assert.deepEqual(createDdinterMechanismReader(db)('DDInter2', 'DDInter1', 'Moderate')?.types, ['metabolism', 'synergy']);
  for (const value of [['antagonism'], ['unknown'], undefined, [], ['future']]) {
    // Omit actions explicitly; default function argument would otherwise add synergy.
    importDdinterGraph(db, graph(value === undefined ? null : value, true), 'DDInter2', '2026-09-25T00:00:00Z');
    assert.equal(createDdinterMechanismReader(db)('DDInter1', 'DDInter2', 'Moderate'), undefined);
  }
});

test('Damaged source bytes, provenance, time, identity or storage association cannot supply a mechanism', () => {
  const db = database(); put(db);
  const original = db.prepare('SELECT * FROM ddinter_web_snapshots').get() as any;
  for (const [column, value] of [['raw', original.raw + ' '], ['source_url', 'https://untrusted.invalid'], ['data_url', 'https://untrusted.invalid'], ['retrieved_at', 'bad date'], ['sha256', 'bad hash']]) {
    db.prepare(`UPDATE ddinter_web_snapshots SET ${column}=?`).run(value);
    assert.equal(createDdinterMechanismReader(db)('DDInter1', 'DDInter2', 'Moderate'), undefined);
    db.prepare(`UPDATE ddinter_web_snapshots SET ${column}=?`).run(original[column]);
  }
  db.prepare("UPDATE ddinter_web_drugs SET normalized_name='different' WHERE id='DDInter2'").run();
  assert.equal(createDdinterMechanismReader(db)('DDInter1', 'DDInter2', 'Moderate'), undefined);
  put(db);
  db.prepare("UPDATE ddinter_web_pairs SET drug_b='DDInter3'").run();
  assert.equal(createDdinterMechanismReader(db)('DDInter1', 'DDInter3', 'Moderate'), undefined);
});

test('New source content invalidates cached classifications without mutating previously returned evidence', () => {
  const db = database(); put(db);
  const read = createDdinterMechanismReader(db), before = read('DDInter1', 'DDInter2', 'Moderate')!;
  const saved = JSON.stringify(before);
  put(db, ['unknown'], false, 'Moderate', '2026-09-25T00:00:00Z');
  assert.deepEqual(read('DDInter1', 'DDInter2', 'Moderate')?.types, ['unknown']);
  assert.notEqual(read('DDInter1', 'DDInter2', 'Moderate')?.sha256, before.sha256);
  assert.equal(JSON.stringify(before), saved);
  db.prepare('DELETE FROM ddinter_web_pairs').run();
  assert.equal(read('DDInter1', 'DDInter2', 'Moderate'), undefined);
});

test('Offline UI and saved report retain simple definitions, original category, source date and limitation', async () => {
  const db = database(); put(db, ['synergy']);
  const provider = new DrugProviders(db, async () => { throw Error('Unexpected request'); });
  const report = await provider.report([product('Alpha'), product('Beta')], 'local');
  const text = reportToMarkdown(report), html = renderToStaticMarkup(createElement(MedicationInteractions, { report }));
  for (const rendered of [text, html]) {
    assert.ok(rendered.includes('來源標示的影響方式'));
    assert.ok(rendered.includes('作用可能增強'));
    assert.ok(rendered.includes('synergy'));
    assert.ok(rendered.includes(mechanismScope));
    assert.ok(rendered.includes('ddinter2.scbdd.com/explanation/'));
  }
  assert.ok(text.includes(escapeMarkdown(date)));
  assert.ok(html.includes('尚未保存詳細原因與處置說明'));
  put(db, ['unknown'], false, 'Unknown');
  const unknown = renderToStaticMarkup(createElement(MedicationInteractions, { report: await provider.report([product('Alpha'), product('Beta')], 'local') }));
  assert.ok(unknown.includes('風險程度未明')); assert.ok(unknown.includes('機轉尚不明'));
  put(db, ['unrecognized']);
  const missing = renderToStaticMarkup(createElement(MedicationInteractions, { report: await provider.report([product('Alpha'), product('Beta')], 'local') }));
  assert.ok(!missing.includes('來源標示的影響方式'));
  assert.ok(missing.includes('尚未保存詳細原因'));
});
