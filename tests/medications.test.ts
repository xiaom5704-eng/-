import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { once } from 'node:events';
import { listenForFetch } from './http-listener';
import { openDrugDatabase, datasetStatus, getTfda, searchTfda, compareIngredients, type DrugDatabase } from '../server/medications/store';
import { importDdinter, importTfda } from '../server/medications/importers';
import { DrugProviders, ingredientAliases } from '../server/medications/providers';
import { verifiedIngredientName } from '../server/medications/verified-names';
import { medicationRouter, validSelections } from '../server/medications/router';
import { filePart } from '../src/services/medication-ai';
import { reportToMarkdown, type DrugCandidate, type MedicationEvidence } from '../shared/medication';
import { summarizeMedicationReport } from '../shared/medication-summary';

// Deliberately synthetic records: test fixtures never seed the application database.
const opened: DrugDatabase[] = [];
const database = () => { const db = openDrugDatabase(':memory:'); opened.push(db); return db; };
afterEach(() => { opened.splice(0).forEach(db => db.close()); });
const row = (name = '測試藥品', id = 'TEST001') => ({ 許可證字號: id, 中文品名: name, 英文品名: 'Test product', 主成分略述: 'Alpha;;Beta', 註銷狀態: '', 有效日期: '2099/01/01' });
const csv = 'DDInterID_A,Drug_A,DDInterID_B,Drug_B,Level\nDDInter1,Alpha,DDInter2,Beta,Major\nDDInter2,Beta,DDInter3,Gamma,Moderate\n';
function seed(db: DrugDatabase) { importTfda(db, [row()]); importDdinter(db, [{ name: 'synthetic.csv', csv }]); }
function med(name: string, ingredients: any[]): MedicationEvidence {
  return { drug: { name, sourceUrl: 'https://data.gov.tw/dataset/9122' } as DrugCandidate, ingredients, labels: [], labelStatus: 'not_found', warnings: [] };
}
const ingredient = (name: string, id?: string) => ({ original: name, name, ddinterId: id, mapping: id ? 'exact' : 'unmapped' });
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
const resolved = [{ original: 'Alpha', name: 'alpha', rxCui: '1', mapping: 'rxnorm' as const }];

test('TFDA import preserves combination ingredients, license state and nullable Chinese names', () => {
  const db = database();
  const result = importTfda(db, [row(), { ...row('舊品', 'TEST002'), 註銷狀態: '已註銷' }, { ...row('', 'TEST003'), 中文品名: null }]);
  assert.equal(result.count, 3);
  assert.deepEqual(getTfda(db, 'TEST001')!.ingredients, ['Alpha', 'Beta']);
  assert.equal(getTfda(db, 'TEST002')!.licenseStatus, '已註銷');
  assert.equal(getTfda(db, 'TEST003')!.name, 'Test product');
});

test('Invalid TFDA import preserves the old snapshot', () => {
  const db = database(); seed(db);
  assert.throws(() => importTfda(db, [{ 中文品名: 'bad schema' }]));
  assert.equal(datasetStatus(db)[0].count, 1);
  assert.ok(getTfda(db, 'TEST001'));
});

test('Search escapes SQL LIKE wildcards and does not interpret SQL', () => {
  const db = database(); importTfda(db, [row('測試 1%'), row('測試 10', 'TEST002')]);
  assert.equal(searchTfda(db, '1%').length, 1);
  assert.equal(searchTfda(db, "' OR 1=1 --").length, 0);
});

test('DDInter import deduplicates reversed pairs and rolls back conflicting levels', () => {
  const db = database(); seed(db);
  importDdinter(db, [{ name: 'synthetic.csv', csv: csv + 'DDInter2,Beta,DDInter1,Alpha,Major\n' }]);
  assert.equal(datasetStatus(db)[1].count, 2);
  assert.throws(() => importDdinter(db, [{ name: 'conflict.csv', csv: csv + 'DDInter2,Beta,DDInter1,Alpha,Minor\n' }]));
  assert.equal(datasetStatus(db)[1].count, 2);
  assert.equal(compareIngredients(db, [med('B', [ingredient('Beta', 'DDInter2')]), med('A', [ingredient('Alpha', 'DDInter1')])])[0].level, 'Major');
});

test('Missing data, unmapped ingredient and no record are distinct outcomes', () => {
  const db = database();
  const a = med('A', [ingredient('Alpha', 'DDInter1')]);
  const c = med('C', [ingredient('Gamma', 'DDInter3')]);
  assert.equal(compareIngredients(db, [a, c])[0].status, 'not_imported');
  seed(db);
  assert.equal(compareIngredients(db, [a, c])[0].status, 'not_found');
  assert.equal(compareIngredients(db, [a, med('Unknown', [ingredient('Missing')])])[0].status, 'unmapped');
});

test('Combination products are checked internally and against other products; duplicate ingredients are flagged', () => {
  const db = database(); seed(db);
  const result = compareIngredients(db, [med('Combination', [ingredient('Alpha', 'DDInter1'), ingredient('Beta', 'DDInter2')]), med('Other', [ingredient('Alpha', 'DDInter1')])]);
  assert.equal(result.length, 3);
  assert.equal(result.filter(r => r.status === 'found').length, 2);
  assert.equal(result.filter(r => r.status === 'duplicate').length, 1);
  assert.equal(result.find(r => r.status === 'duplicate')!.sourceUrl, 'https://data.gov.tw/dataset/9122');
  assert.equal(result.filter(r => r.scope === 'within_product').length, 1);
  assert.equal(result.filter(r => r.scope === 'between_products').length, 2);
});

test('Reviewed ingredient aliases preserve qualifiers and restrict product evidence to its license', () => {
  const product = { source: 'tfda' as const, id: '衛署藥輸字第023784號' };
  assert.equal(verifiedIngredientName(' caffeine  anhydrous ')?.name, 'caffeine');
  assert.equal(verifiedIngredientName('ACETAMINOPHEN FINE', product)?.name, 'acetaminophen');
  assert.equal(verifiedIngredientName('ASCORBIC ACID (COATED)', product)?.name, 'ascorbic acid');
  assert.equal(verifiedIngredientName('ACETAMINOPHEN FINE'), undefined);
  assert.equal(verifiedIngredientName('ACETAMINOPHEN FINE', { ...product, id: 'OTHER' }), undefined);
  assert.equal(verifiedIngredientName('ACETAMINOPHEN FINE', { ...product, source: 'rxnorm' }), undefined);
  for (const name of ['CAFFEINE CITRATE', 'CAFFEINE MONOHYDRATE', 'ALPHA (COATED)', 'ALPHA FINE']) {
    assert.equal(verifiedIngredientName(name, product), undefined);
    assert.deepEqual(ingredientAliases(name), [name]);
  }
});

test('Verified aliases detect both duplicate ingredients even while RxNorm is offline', async () => {
  const db = database();
  importDdinter(db, [{ name: 'synthetic.csv', csv: 'DDInterID_A,Drug_A,DDInterID_B,Drug_B,Level\nDDInter100,Acetaminophen,DDInter101,Caffeine,Minor\n' }]);
  const providers = new DrugProviders(db, (async () => { throw new Error('offline'); }) as typeof fetch);
  const source = { source: 'tfda' as const, id: '衛署藥輸字第023784號' };
  const first = [...await providers.resolveIngredient('ACETAMINOPHEN (EQ TO PARACETAMOL)'), ...await providers.resolveIngredient('CAFFEINE ANHYDROUS')];
  const second = [...await providers.resolveIngredient('ACETAMINOPHEN FINE', source), ...await providers.resolveIngredient('CAFFEINE ANHYDROUS', source)];
  const result = compareIngredients(db, [med('Powder', first), med('Cold tablet', second)]);
  assert.equal(result.filter(p => p.status === 'duplicate').length, 2);
  assert.equal(second[0].original, 'ACETAMINOPHEN FINE');
  assert.equal(second[0].rxCui, undefined);
  assert.ok(second[0].aliasSourceUrl?.startsWith('https://www.fda.gov.tw/'));
  assert.equal((await providers.labels(second)).status, 'unmapped');
});

test('Verified names unblock complete-ingredient label lookup and retain provenance in saved reports', async () => {
  const db = database();
  importTfda(db, [{ ...row('Reviewed product', '衛署藥輸字第023784號'), 主成分略述: 'ACETAMINOPHEN FINE;;CAFFEINE ANHYDROUS;;ASCORBIC ACID (COATED);;NOSCAPINE;;TERPIN HYDRATE;;PHENYLEPHRINE HCL' }]);
  const names: Record<string, string> = { acetaminophen: '161', caffeine: '1886', 'ascorbic acid': '1151', noscapine: '900001', 'terpin hydrate': '900002', 'phenylephrine hcl': '900003' };
  let labelCalls = 0;
  const providers = new DrugProviders(db, (async (url: URL) => {
    if (url.pathname.endsWith('/version.json')) return json({ version: '08-Sep-2026' });
    if (url.hostname === 'api.fda.gov') {
      labelCalls++;
      for (const name of Object.keys(names)) assert.ok(url.searchParams.get('search')!.includes(name));
      return json({ results: [{ id: 'synthetic', openfda: { substance_name: Object.keys(names) } }] });
    }
    if (url.pathname.endsWith('/related.json')) {
      const id = url.pathname.split('/')[3];
      return json({ relatedGroup: { conceptGroup: [{ tty: 'IN', conceptProperties: [{ rxcui: id, name: Object.keys(names).find(n => names[n] === id), tty: 'IN', suppress: 'N' }] }] } });
    }
    if (url.pathname.endsWith('/properties.json')) {
      const id = url.pathname.split('/')[3];
      return json({ properties: { rxcui: id, name: Object.keys(names).find(n => names[n] === id), tty: 'IN', suppress: 'N' } });
    }
    const id = names[(url.searchParams.get('name') || '').toLowerCase()];
    return json({ idGroup: id ? { rxnormId: [id] } : {} });
  }) as unknown as typeof fetch);
  const report = await providers.report([getTfda(db, '衛署藥輸字第023784號')!]);
  assert.equal(labelCalls, 1);
  assert.equal(report.medications[0].labelStatus, 'found');
  assert.ok(report.medications[0].ingredients.every(i => i.rxCui));
  assert.equal(report.medications[0].ingredients.filter(i => i.aliasSourceUrl).length, 3);
  const markdown = reportToMarkdown(report);
  assert.ok(markdown.includes('©2021'));
  assert.ok(markdown.includes('別名核對：ACETAMINOPHEN FINE → acetaminophen'));
  assert.ok(markdown.includes('precision.fda.gov'));
});

test('RxNorm ambiguity never automatically selects the first result', async () => {
  const db = database();
  let exactCalls = 0;
  const providers = new DrugProviders(db, (async (url: URL) => {
    if (url.pathname.endsWith('/version.json')) return json({ version: '08-Sep-2026' });
    exactCalls++;
    return json({ idGroup: { rxnormId: ['1', '2'] } });
  }) as unknown as typeof fetch);
  const result = await providers.resolveIngredient('Alpha');
  assert.equal(result[0].mapping, 'unmapped');
  assert.equal(result[0].rxCui, undefined);
  assert.equal(exactCalls, 1);
});

test('English search includes the exact ingredient before related product forms', async () => {
  const db = database();
  const providers = new DrugProviders(db, (async (url: URL) => {
    if (url.pathname.endsWith('/drugs.json')) return json({ drugGroup: { conceptGroup: [{ tty: 'SCD', conceptProperties: [{ rxcui: '20', name: 'Alpha 20 MG tablet', tty: 'SCD' }] }] } });
    if (url.pathname.endsWith('/properties.json')) return json({ properties: { rxcui: '1', name: 'Alpha', tty: 'IN' } });
    return json({ idGroup: { rxnormId: ['1'] } });
  }) as unknown as typeof fetch);
  const candidates = await providers.searchRxnorm('Alpha');
  assert.equal(candidates[0].id, '1');
  assert.deepEqual(candidates[0].ingredients, ['Alpha']);
  assert.equal(candidates[1].id, '20');
});

test('Provider failure still permits an exact local DDInter match', async () => {
  const db = database(); seed(db);
  const providers = new DrugProviders(db, (async () => { throw new Error('offline'); }) as typeof fetch);
  const result = await providers.resolveIngredient('Alpha');
  assert.equal(result[0].ddinterId, 'DDInter1');
  assert.equal(result[0].rxCui, undefined);
});

test('Only explicit TFDA equivalence annotations become alternative names', async () => {
  assert.deepEqual(ingredientAliases('ALPHA (EQ TO BETA)'), ['ALPHA (EQ TO BETA)', 'ALPHA', 'BETA']);
  assert.deepEqual(ingredientAliases('ALPHA (SODIUM SALT)'), ['ALPHA (SODIUM SALT)']);
  const db = database(); seed(db);
  const providers = new DrugProviders(db, (async () => { throw new Error('offline'); }) as typeof fetch);
  const result = await providers.resolveIngredient('Alpha (EQ TO NOT-IN-DDINTER)');
  assert.equal(result[0].ddinterId, 'DDInter1');
  assert.equal(result[0].original, 'Alpha (EQ TO NOT-IN-DDINTER)');
});

test('FDA label filter rejects extra or missing ingredients and preserves complete paragraphs', async () => {
  const db = database();
  const paragraph = 'Synthetic instructions with a qualifying final sentence. '.repeat(1000);
  const label = (id: string, ingredients: string[]) => ({ id, openfda: { substance_name: ingredients }, dosage_and_administration: [paragraph] });
  const providers = new DrugProviders(db, (async () => json({ results: [label('single', ['ALPHA']), label('combination', ['ALPHA', 'BETA']), label('unknown', [])] })) as typeof fetch);
  const result = await providers.labels(resolved);
  assert.equal(result.status, 'found');
  assert.equal(result.labels.length, 1);
  assert.equal(result.labels[0].id, 'single');
  assert.equal(result.labels[0].sections[0].text, paragraph);
});

test('FDA preserves pediatric, geriatric and population sections without inventing missing guidance', async () => {
  const db = database();
  const geriatric = 'Synthetic older adult guidance. '.repeat(1000) + 'Final qualifier must remain.';
  const providers = new DrugProviders(db, (async () => json({ results: [{ id: 'all-ages', openfda: { substance_name: ['ALPHA'] },
    pediatric_use: ['Synthetic pediatric information.'], geriatric_use: [geriatric], use_in_specific_populations: ['Synthetic population information.'] }] })) as typeof fetch);
  const result = await providers.labels(resolved);
  assert.equal(result.status, 'found');
  assert.deepEqual(result.labels[0].sections.map(section => section.title), ['兒童使用資訊', '高齡者使用資訊', '特定族群使用資訊']);
  assert.equal(result.labels[0].sections[1].text, geriatric);
  const absent = await new DrugProviders(database(), (async () => json({ results: [{ id: 'missing', openfda: { substance_name: ['ALPHA'] } }] })) as typeof fetch).labels(resolved);
  assert.deepEqual(absent.labels[0].sections, []);
});

test('FDA 404 no match, HTTP failure and malformed success are not conflated', async () => {
  for (const [response, expected] of [
    [json({ error: { code: 'NOT_FOUND' } }, 404), 'not_found'],
    [json({ error: { code: 'RATE_LIMIT' } }, 429), 'unavailable'],
    [json({ unexpected: true }), 'unavailable'],
  ] as const) {
    const providers = new DrugProviders(database(), (async () => response) as typeof fetch);
    assert.equal((await providers.labels(resolved)).status, expected);
  }
});

test('Network failures are not cached; successful responses are cached', async () => {
  let calls = 0;
  const providers = new DrugProviders(database(), (async () => ++calls === 1 ? json({}, 503) : json({ results: [] })) as typeof fetch);
  assert.equal((await providers.labels(resolved)).status, 'unavailable');
  assert.equal((await providers.labels(resolved)).status, 'not_found');
  await providers.labels(resolved);
  assert.equal(calls, 2);
});

test('Malformed successful responses are not cached', async () => {
  let calls = 0;
  const providers = new DrugProviders(database(), (async () => json(++calls === 1 ? { unexpected: true } : { results: [] })) as typeof fetch);
  assert.equal((await providers.labels(resolved)).status, 'unavailable');
  assert.equal((await providers.labels(resolved)).status, 'not_found');
  assert.equal(calls, 2);
});

test('Conflicting official aliases remain unresolved', async () => {
  const db = database(); seed(db);
  const providers = new DrugProviders(db, (async () => { throw new Error('should not query ambiguous aliases'); }) as typeof fetch);
  const result = await providers.resolveIngredient('Alpha (EQ TO Beta)');
  assert.equal(result[0].mapping, 'unmapped');
  assert.equal(result[0].ddinterId, undefined);
});

test('Selections reject duplicates, oversized requests and nonnumeric RxCUIs', () => {
  assert.ok(validSelections([{ source: 'tfda', id: 'TEST001' }]));
  assert.equal(validSelections([]), false);
  assert.equal(validSelections([{ source: 'rxnorm', id: '../123' }]), false);
  assert.equal(validSelections([{ source: 'tfda', id: 'X' }, { source: 'tfda', id: 'X' }]), false);
  assert.equal(validSelections(Array.from({ length: 7 }, (_, i) => ({ source: 'rxnorm', id: String(i) }))), false);
});

test('Report API resolves the stored product instead of trusting client ingredients', async () => {
  const db = database(); seed(db);
  let received: DrugCandidate[] = [];
  const provider = { report: async (drugs: DrugCandidate[]) => { received = drugs; return { checkedAt: new Date().toISOString(), datasets: [], interactions: [], limitations: [],
    medications: drugs.map(drug => ({ drug, ingredients: [], labels: [], labelStatus: 'not_requested', warnings: [] })) }; } } as unknown as DrugProviders;
  const app = express(); app.use(express.json()); app.use('/api/medications', medicationRouter(db, provider));
  const server = await listenForFetch(app);
  const port = (server.address() as any).port;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/medications/report`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ drugs: [{ source: 'tfda', id: 'TEST001', ingredients: ['Fake'] }] }) });
    assert.equal(response.status, 200);
    assert.deepEqual(received[0].ingredients, ['Alpha', 'Beta']);
    const invalid = await fetch(`http://127.0.0.1:${port}/api/medications/report`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(invalid.status, 400);
  } finally { server.close(); await once(server, 'close'); }
});

test('OCR retains PDF/PNG MIME types and rejects unexpected formats', () => {
  assert.equal(filePart('data:application/pdf;base64,SGVsbG8=').inlineData.mimeType, 'application/pdf');
  assert.equal(filePart('data:image/png;base64,SGVsbG8=').inlineData.mimeType, 'image/png');
  assert.throws(() => filePart('data:text/html;base64,SGVsbG8='));
});

test('Saved reports retain sources and uncertainty, and escape source Markdown', async () => {
  const db = database(); seed(db);
  const providers = new DrugProviders(db, (async () => { throw new Error('offline'); }) as typeof fetch);
  const drug = getTfda(db, 'TEST001')!; drug.name = '[not a link](https://invalid.example)';
  const report = await providers.report([drug]);
  const markdown = reportToMarkdown(report);
  assert.ok(markdown.includes('不代表沒有交互作用'));
  assert.ok(markdown.includes('https://data.gov.tw/dataset/9122'));
  assert.ok(markdown.includes('許可證：TEST001'));
  assert.ok(markdown.includes('同一品項的複方內：'));
  assert.ok(markdown.includes('\\[not a link\\]'));
  assert.equal(report.medications[0].labelStatus, 'unmapped');
});

test('Summary does not invent interaction findings when no pair can be compared', async () => {
  const db = database(); importTfda(db, [{ ...row(), 主成分略述: 'Alpha' }]);
  const providers = new DrugProviders(db, (async () => { throw new Error('offline'); }) as typeof fetch);
  const report = await providers.report([getTfda(db, 'TEST001')!]);
  const summary = summarizeMedicationReport(report);
  assert.ok(summary.includes('沒有可比較的成分配對'));
  assert.ok(summary.includes('未對照而未查詢仿單'));
  assert.equal(summary.includes('DDInter 查得紀錄'), false);
  assert.ok(summarizeMedicationReport(report, 'English').includes('no ingredient pairs to compare'));
});

test('Summary preserves found, missing and unknown states without inference', () => {
  const base = { checkedAt: '2026-09-17', datasets: [], medications: [], limitations: [] };
  const summary = summarizeMedicationReport({ ...base, interactions: [
    { drugA: 'A', drugB: 'B', ingredientA: 'Alpha', ingredientB: 'Beta', status: 'found', level: 'Major', sourceUrl: '' },
    { drugA: 'A', drugB: 'C', ingredientA: 'Alpha', ingredientB: 'Gamma', status: 'not_found', sourceUrl: '' },
    { drugA: 'A', drugB: 'D', ingredientA: 'Alpha', ingredientB: 'Delta', status: 'unmapped', sourceUrl: '' },
  ] });
  assert.ok(summary.includes('DDInter 查得紀錄；資料庫風險等級：重大'));
  assert.ok(summary.includes('未查得紀錄（不代表安全）'));
  assert.ok(summary.includes('成分未完成 DDInter 對照，無法判定'));
});
