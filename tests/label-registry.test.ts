import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DrugProviders, ingredientLookup } from '../server/medications/providers';
import { getTfda, openDrugDatabase, type DrugDatabase } from '../server/medications/store';
import { importTfda } from '../server/medications/importers';
import { writeIngredientRecord } from '../server/medications/ingredient-registry';
import { labelContext, readLabelSnapshot } from '../server/medications/label-registry';
import { reportToMarkdown, type ResolvedIngredient } from '../shared/medication';
import { summarizeMedicationReport } from '../shared/medication-summary';
import MedicationLeaflets from '../src/components/MedicationLeaflets';

const ingredients: ResolvedIngredient[] = [{ original: 'ALPHA', name: 'alpha', rxCui: '1', mapping: 'rxnorm' }];
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const paragraph = 'SYNTHETIC full text with an important final qualifier. '.repeat(800);
const label = (id = 'synthetic-label', names = ['ALPHA'], setId = 'synthetic-set') => ({ id, set_id: setId, version: '2', effective_time: '20260901',
  openfda: { substance_name: names, brand_name: ['SYNTHETIC'], generic_name: ['ALPHA'], route: ['ORAL'] },
  boxed_warning: ['SYNTHETIC boxed warning'], pediatric_use: [paragraph], warnings: ['SYNTHETIC warning'] });
const expandedLabel = () => ({ ...label(), precautions: ['SYNTHETIC precautions with a final qualifier.'], general_precautions: ['SYNTHETIC general precautions'],
  ask_doctor_or_pharmacist: ['SYNTHETIC ask a pharmacist before combining'], when_using: ['SYNTHETIC during use'],
  information_for_patients: ['SYNTHETIC patient information <script>alert(1)</script>'], keep_out_of_reach_of_children: ['SYNTHETIC keep away'],
  drug_and_or_laboratory_test_interactions: ['SYNTHETIC test interactions'], spl_medguide: ['SYNTHETIC guide'],
  dosage_and_administration_table: ['<table><tr><td>SYNTHETIC only</td></tr></table>'] });
function database(t: TestContext) { const db = openDrugDatabase(':memory:'); t.after(() => db.close()); return db; }
function seedDrug(db: DrugDatabase) {
  importTfda(db, [{ 許可證字號: 'SYNTHETIC001', 中文品名: '人工測試藥品', 英文品名: 'TEST', 主成分略述: 'ALPHA' }]);
  const drug = getTfda(db, 'SYNTHETIC001')!;
  writeIngredientRecord(db, ingredientLookup('ALPHA', drug).key, { schema: 1, status: 'matched', version: '08-Sep-2026', checkedAt: new Date().toISOString(),
    lookupUrl: 'https://rxnav.nlm.nih.gov/REST/rxcui.json?name=ALPHA&search=0',
    matched: { name: 'alpha', rxcui: '1', tty: 'IN' }, ingredient: { name: 'alpha', rxcui: '1', tty: 'IN' } });
  return drug;
}

function makeLegacy(db: DrugDatabase) {
  const context = labelContext(ingredients)!;
  const snapshot = JSON.parse((db.prepare('SELECT payload FROM label_registry WHERE key=?').get(context.key) as { payload: string }).payload);
  delete snapshot.textVersion; delete snapshot.rawLabels; delete snapshot.tableVersion;
  for (const entry of snapshot.labels) {
    delete entry.hasTables;
    entry.sections = entry.sections.filter(section => ['加框警語', '兒童使用資訊', '警語'].includes(section.title));
  }
  db.prepare('UPDATE label_registry SET payload=? WHERE key=?').run(JSON.stringify(snapshot), context.key);
  return snapshot;
}

test('Additional FDA safety sections survive persistence and appear verbatim in the UI and saved report', async t => {
  const db = database(t), drug = seedDrug(db);
  await new DrugProviders(db, (async () => json({ results: [expandedLabel()] })) as typeof fetch).labels(ingredients);
  const report = await new DrugProviders(db, (async () => { throw new Error('network forbidden'); }) as typeof fetch).report([drug], 'local');
  const entry = report.medications[0];
  const titles = entry.labels[0].sections.map(section => section.title);
  for (const title of ['注意事項', '一般注意事項', '使用前詢問醫師或藥師', '使用期間注意事項', '給使用者的資訊', '兒童誤用防範', '藥品與檢驗的交互影響', '用藥指南']) assert.ok(titles.includes(title), title);
  assert.equal(entry.labelLookup!.textSectionsExpanded, true);
  assert.equal(entry.labels[0].hasTables, true);
  const html = renderToStaticMarkup(React.createElement(MedicationLeaflets, { report }));
  assert.match(html, /SYNTHETIC precautions with a final qualifier/);
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;')); assert.ok(!html.includes('<script>'));
  assert.match(reportToMarkdown(report), /SYNTHETIC ask a pharmacist before combining/);
  assert.match(html, /原始資料表格/); assert.match(reportToMarkdown(report), /原始資料表格/);
  assert.equal('rawLabels' in entry.labelLookup!, false);
  const stored = readLabelSnapshot(db, labelContext(ingredients)!)!;
  assert.deepEqual(stored.rawLabels, [expandedLabel()]);
});

test('Legacy snapshots recover missing sections offline from their original cache, retaining dates and after cache removal', async t => {
  const db = database(t), context = labelContext(ingredients)!;
  await new DrugProviders(db, (async () => json({ results: [expandedLabel()] })) as typeof fetch).labels(ingredients);
  const legacy = makeLegacy(db);
  db.prepare('UPDATE drug_api_cache SET expires=0').run();
  let calls = 0;
  const provider = new DrugProviders(db, (async () => { calls++; throw new Error('network forbidden'); }) as typeof fetch);
  const result = await provider.labels(ingredients, 'local');
  assert.equal(calls, 0); assert.equal(result.lookup!.textSectionsExpanded, true);
  assert.equal(result.lookup!.retrievedAt, legacy.retrievedAt); assert.equal(result.lookup!.refresh, 'not_requested');
  assert.ok(result.labels[0].sections.some(section => section.title === '注意事項'));
  db.exec('DELETE FROM drug_api_cache');
  assert.deepEqual((await provider.labels(ingredients, 'local')).labels, result.labels);
  assert.equal(readLabelSnapshot(db, context)!.textVersion, 2);
});

test('Missing, malformed or different-version cached records do not overwrite a legacy snapshot or hide its partial status', async t => {
  for (const change of ['missing', 'date', 'version', 'ingredients', 'text', 'new-field'] as const) {
    const db = database(t), context = labelContext(ingredients)!;
    await new DrugProviders(db, (async () => json({ results: [expandedLabel()] })) as typeof fetch).labels(ingredients);
    const legacy = makeLegacy(db);
    if (change === 'missing') db.exec('DELETE FROM drug_api_cache');
    else if (change === 'date') db.exec('UPDATE drug_api_cache SET retrieved_at=NULL');
    else {
      const raw: any = expandedLabel();
      if (change === 'version') raw.version = 'different';
      if (change === 'ingredients') raw.openfda.substance_name.push('BETA');
      if (change === 'text') raw.warnings = ['different source text'];
      if (change === 'new-field') raw.precautions = ['text', 123];
      db.prepare('UPDATE drug_api_cache SET value=? WHERE key=?').run(JSON.stringify({ results: [raw] }), context.url);
    }
    const result = await new DrugProviders(db, (async () => { throw new Error('network forbidden'); }) as typeof fetch).labels(ingredients, 'local');
    assert.equal(result.status, 'found', change); assert.deepEqual(result.labels, legacy.labels, change);
    assert.equal(result.lookup!.textSectionsExpanded, false, change);
    assert.deepEqual(readLabelSnapshot(db, context), legacy, change);
  }
});

test('Malformed newly supported fields cannot replace a verified expanded snapshot', async t => {
  const db = database(t), context = labelContext(ingredients)!;
  await new DrugProviders(db, (async () => json({ results: [expandedLabel()] })) as typeof fetch).labels(ingredients);
  const original = readLabelSnapshot(db, context)!;
  db.exec('DELETE FROM drug_api_cache');
  const result = await new DrugProviders(db, (async () => json({ results: [{ ...expandedLabel(), ask_doctor_or_pharmacist: [123] }] })) as typeof fetch).labels(ingredients);
  assert.equal(result.lookup!.refresh, 'failed'); assert.deepEqual(result.labels, original.labels);
  assert.deepEqual(readLabelSnapshot(db, context), original);
});

test('Saved labels survive restart, preserve full sections and versions, and appear in offline UI and reports without network calls', async t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'medsafe-labels-'));
  let db = openDrugDatabase(path.join(root, 'drugs.db'));
  t.after(() => { db.close(); assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('medsafe-labels-')); rmSync(root, { recursive: true, force: true }); });
  const drug = seedDrug(db);
  const online = await new DrugProviders(db, (async () => json({ meta: { last_updated: '2026-09-19', results: { total: 1 } }, results: [label()] })) as typeof fetch).labels(ingredients);
  assert.equal(online.status, 'found'); assert.equal(online.lookup!.refresh, 'succeeded');
  db.close(); db = openDrugDatabase(path.join(root, 'drugs.db'));
  let requests = 0;
  const report = await new DrugProviders(db, (async () => { requests++; throw new Error('must stay offline'); }) as typeof fetch).report([drug], 'local');
  const entry = report.medications[0];
  assert.equal(requests, 0); assert.deepEqual(entry.labels, online.labels);
  assert.equal(entry.labelLookup!.retrievedAt, online.lookup!.retrievedAt); assert.equal(entry.labelLookup!.refresh, 'not_requested');
  assert.equal(entry.labels[0].version, '2'); assert.equal(entry.labels[0].setId, 'synthetic-set');
  assert.equal(entry.labels[0].sections.find(section => section.title === '兒童使用資訊')!.text, paragraph);
  const markdown = reportToMarkdown(report), html = renderToStaticMarkup(React.createElement(MedicationLeaflets, { report }));
  assert.match(markdown, /重用本機紀錄/); assert.match(markdown, /版本：2/); assert.match(html, /本機紀錄/);
  assert.ok(html.includes(online.lookup!.retrievedAt)); assert.ok(html.includes('SYNTHETIC boxed warning'));
  for (const language of ['繁體中文', 'English', '日本語', 'Tiếng Việt']) assert.ok(summarizeMedicationReport(report, language).includes(online.lookup!.retrievedAt));
});

test('FDA screening continues past the first page and preserves two distinct label sets', async t => {
  const db = database(t); const skips: string[] = [];
  const result = await new DrugProviders(db, (async (url: URL) => {
    skips.push(url.searchParams.get('skip') || '0'); assert.equal(url.searchParams.get('limit'), '100');
    return json({ meta: { results: { total: 103 } }, results: skips.length === 1 ? Array.from({ length: 100 }, (_, i) => label(`combo-${i}`, ['ALPHA', 'BETA'])) :
      [label('a-v2', ['ALPHA'], 'set-a'), label('a-v1', ['ALPHA'], 'set-a'), label('b-v2', ['ALPHA'], 'set-b')] });
  }) as unknown as typeof fetch).labels(ingredients);
  assert.deepEqual(skips, ['0', '100']); assert.deepEqual(result.labels.map(item => item.id), ['a-v2', 'b-v2']);
  assert.equal(result.lookup!.scanned, 103); assert.equal(result.lookup!.complete, true);
});

test('Bounded partial screening is incomplete, never a false no-record result, including when reused offline', async t => {
  const db = database(t); let requests = 0;
  const provider = new DrugProviders(db, (async () => {
    requests++; return json({ meta: { results: { total: 700 } }, results: Array.from({ length: 100 }, (_, i) => label(`combo-${requests}-${i}`, ['ALPHA', 'BETA'])) });
  }) as typeof fetch);
  const partial = await provider.labels(ingredients);
  assert.equal(requests, 5); assert.equal(partial.status, 'incomplete'); assert.equal(partial.lookup!.scanned, 500); assert.equal(partial.lookup!.complete, false);
  assert.equal((await provider.labels(ingredients, 'local')).status, 'incomplete'); assert.equal(requests, 5);
});

test('Failed refresh retains original dated records; completed no-match replaces them and remains distinct offline', async t => {
  const db = database(t), drug = seedDrug(db);
  await new DrugProviders(db, (async () => json({ results: [label()] })) as typeof fetch).labels(ingredients);
  const context = labelContext(ingredients)!;
  const saved = readLabelSnapshot(db, context)!;
  const oldDate = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
  db.prepare('UPDATE label_registry SET payload=? WHERE key=?').run(JSON.stringify({ ...saved, retrievedAt: oldDate }), context.key);
  db.exec('DELETE FROM drug_api_cache');
  const failed = await new DrugProviders(db, (async () => { throw new Error('offline'); }) as typeof fetch).report([drug], 'online');
  const entry = failed.medications[0];
  assert.equal(entry.labelStatus, 'found'); assert.equal(entry.labelLookup!.refresh, 'failed'); assert.equal(entry.labelLookup!.stale, true);
  assert.equal(entry.labelLookup!.retrievedAt, oldDate); assert.equal(readLabelSnapshot(db, context)!.retrievedAt, oldDate);
  assert.match(reportToMarkdown(failed), /這次更新失敗/); assert.match(summarizeMedicationReport(failed, 'English'), /refresh failed/);
  const provider = new DrugProviders(db, (async () => json({ error: { code: 'NOT_FOUND' } }, 404)) as typeof fetch);
  assert.equal((await provider.labels(ingredients)).status, 'not_found');
  const missing = await provider.labels(ingredients, 'local');
  assert.equal(missing.status, 'not_found'); assert.equal(missing.labels.length, 0); assert.notEqual(missing.lookup!.retrievedAt, oldDate);
});

test('Changed normalized identities, extra ingredients and corrupt saved data cannot inherit an old leaflet', async t => {
  const db = database(t), provider = new DrugProviders(db, (async () => json({ results: [label()] })) as typeof fetch);
  await provider.labels(ingredients);
  assert.equal((await provider.labels([{ ...ingredients[0], rxCui: '2' }], 'local')).status, 'not_requested');
  assert.equal((await provider.labels([...ingredients, { ...ingredients[0], name: 'beta', rxCui: '3' }], 'local')).status, 'not_requested');
  const context = labelContext(ingredients)!, saved = readLabelSnapshot(db, context)!;
  saved.labels[0].ingredients.push('BETA');
  db.prepare('UPDATE label_registry SET payload=? WHERE key=?').run(JSON.stringify(saved), context.key);
  assert.equal((await provider.labels(ingredients, 'local')).status, 'not_requested');
});

test('Cached responses keep acquisition dates; malformed pages are retried and cannot poison durable records', async t => {
  const db = database(t); let requests = 0;
  const provider = new DrugProviders(db, (async () => {
    requests++; return json({ results: [{ ...label(), ...(requests === 1 ? { pediatric_use: ['valid', 123] } : {}) }] });
  }) as typeof fetch);
  assert.equal((await provider.labels(ingredients)).status, 'unavailable');
  const fresh = await provider.labels(ingredients); assert.equal(requests, 2); assert.equal(fresh.status, 'found');
  const cached = await provider.labels(ingredients); assert.equal(requests, 2); assert.equal(cached.lookup!.refresh, 'cached');
  assert.equal(cached.lookup!.retrievedAt, fresh.lookup!.retrievedAt);
});

test('Legacy HTTP cache without acquisition dates is re-fetched instead of receiving a fabricated current date', async t => {
  const db = database(t), context = labelContext(ingredients)!;
  db.prepare('INSERT INTO drug_api_cache(key,value,expires) VALUES(?,?,?)').run(context.url, JSON.stringify({ results: [label('old')] }), Date.now() + 60_000);
  let requests = 0;
  const result = await new DrugProviders(db, (async () => { requests++; return json({ results: [label('fresh')] }); }) as typeof fetch).labels(ingredients);
  assert.equal(requests, 1); assert.equal(result.labels[0].id, 'fresh'); assert.equal(result.lookup!.refresh, 'succeeded');
});

test('A changing result set between pages does not overwrite an earlier verified snapshot', async t => {
  const db = database(t);
  await new DrugProviders(db, (async () => json({ results: [label('original')] })) as typeof fetch).labels(ingredients);
  const original = readLabelSnapshot(db, labelContext(ingredients)!)!;
  db.exec('DELETE FROM drug_api_cache'); let requests = 0;
  const result = await new DrugProviders(db, (async () => {
    requests++; return json({ meta: { results: { total: requests === 1 ? 200 : 201 } }, results: Array.from({ length: 100 }, (_, i) => label(`combo-${i}`, ['ALPHA', 'BETA'])) });
  }) as typeof fetch).labels(ingredients);
  assert.equal(result.lookup!.refresh, 'failed'); assert.equal(result.labels[0].id, 'original');
  assert.deepEqual(readLabelSnapshot(db, labelContext(ingredients)!), original);
});

test('Only proven salt names can match a complete label ingredient set, and saved aliases remain context-scoped', async t => {
  const db = database(t);
  const reviewed: ResolvedIngredient[] = [{ ...ingredients[0], normalization: { checkedAt: new Date().toISOString(), version: '08-Sep-2026', reused: true,
    matchedName: 'alpha maleate', matchedRxCui: '10', lookupUrl: 'https://rxnav.nlm.nih.gov/REST/rxcui.json?name=alpha%20maleate&search=0',
    sourceUrl: 'https://rxnav.nlm.nih.gov/REST/rxcui/10/related.json?tty=IN' } }];
  const provider = new DrugProviders(db, (async (url: URL) => {
    assert.ok(url.searchParams.get('search')!.includes('alpha maleate'));
    return json({ results: [label('exact-salt', ['ALPHA MALEATE']), label('wrong-salt', ['ALPHA SODIUM']), label('extra', ['ALPHA MALEATE', 'BETA'])] });
  }) as unknown as typeof fetch);
  const result = await provider.labels(reviewed);
  assert.deepEqual(result.labels.map(item => item.id), ['exact-salt']);
  assert.equal((await provider.labels(reviewed, 'local')).status, 'found');
  assert.equal((await provider.labels(ingredients, 'local')).status, 'not_requested', 'unreviewed original names cannot inherit a PIN-specific search');
  const different = [{ ...reviewed[0], normalization: { ...reviewed[0].normalization!, matchedName: 'alpha sodium', matchedRxCui: '11' } }];
  assert.equal((await provider.labels(different, 'local')).status, 'not_requested');
});
