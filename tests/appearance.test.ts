import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { listenForFetch } from './http-listener';
import AdmZip from 'adm-zip';
import express from 'express';
import { importAppearance, matchObservation, validObservations } from '../server/medications/appearance';
import { datasetStatus, getTfda, openDrugDatabase, searchTfda } from '../server/medications/store';
import { importDdinter, importTfda } from '../server/medications/importers';
import { DrugProviders } from '../server/medications/providers';
import { medicationRouter } from '../server/medications/router';
import { reportToMarkdown, type MedicationObservation } from '../shared/medication';
import { summarizeMedicationReport } from '../shared/medication-summary';
import { extractMedicationNames } from '../src/services/medication-ai';

const headers = ['許可證字號', '中文品名', '英文品名', '形狀', '特殊劑型', '顏色', '特殊氣味', '刻痕', '外觀尺寸', '標註一', '標註二', '外觀圖檔連結'];
const row = (id = 'TEST001', extra: Record<string, string> = {}) => ({ 許可證字號: id, 中文品名: '測試錠', 英文品名: 'SYNTHETIC TABLET',
  形狀: '圓形', 顏色: '白', 刻痕: '直線', 外觀尺寸: '8', 標註一: 'FY T061', 標註二: '25',
  外觀圖檔連結: 'https://mcp.fda.gov.tw/insert/shapeImg/synthetic?c=o', ...extra });
const csv = (rows: Record<string, string>[]) => Buffer.from('\uFEFF' + [headers, ...rows.map(row => headers.map(key => row[key] || ''))]
  .map(values => values.map(value => `"${value.replaceAll('"', '""')}"`).join(',')).join('\r\n'));
const observe = (appearance?: MedicationObservation['appearance'], name = ''): MedicationObservation => ({ name, strength: '', dosageForm: '', ...(appearance ? { appearance } : {}) });
const database = (t: TestContext) => { const db = openDrugDatabase(':memory:'); t.after(() => db.close()); return db; };
function seed(t: TestContext) {
  const db = database(t);
  importTfda(db, [{ 許可證字號: 'TEST001', 中文品名: '測試錠', 英文品名: 'SYNTHETIC TABLET', 主成分略述: 'Alpha;;Beta', 適應症: '僅供軟體測試', 有效日期: '2099/01/01' }]);
  importDdinter(db, [{ name: 'synthetic.csv', csv: 'DDInterID_A,Drug_A,DDInterID_B,Drug_B,Level\nDDInter1,Alpha,DDInter2,Beta,Major\n' }]);
  importAppearance(db, csv([row()]), 'synthetic.csv');
  return db;
}

test('BOM CSV and ZIP import join by license while retaining ingredients and full appearance fields', t => {
  const db = seed(t);
  const zip = new AdmZip(); zip.addFile('42_2.csv', csv([row('TEST001', { 中文品名: '外觀舊名', 顏色: '紅;;;白', 形狀: '膠囊', 外觀圖檔連結: 'https://mcp.fda.gov.tw/one;;;https://mcp.fda.gov.tw/two' }), row('UNLINKED', { 中文品名: '' })]));
  const metadata = importAppearance(db, zip.toBuffer(), 'synthetic.csv.zip', '2026-09-19T00:00:00Z');
  assert.equal(metadata.count, 2); assert.equal(metadata.sha256?.length, 64);
  const drug = getTfda(db, 'TEST001')!;
  assert.equal(drug.name, '測試錠'); assert.deepEqual(drug.ingredients, ['Alpha', 'Beta']);
  assert.equal(drug.appearance?.color, '紅;;;白'); assert.equal(drug.appearance?.imageUrls.length, 2);
  assert.equal(getTfda(db, 'UNLINKED')!.appearanceOnly, true);
  assert.deepEqual(getTfda(db, 'UNLINKED')!.ingredients, []);
  assert.equal(getTfda(db, 'UNLINKED')!.name, 'SYNTHETIC TABLET');
  assert.equal(datasetStatus(db).find(item => item.source === 'ddinter')!.count, 1);
});

test('Invalid or duplicate CSV and ambiguous ZIP updates leave the previous snapshot intact', t => {
  const db = seed(t);
  const before = getTfda(db, 'TEST001');
  for (const data of [Buffer.from('wrong,headers\na,b'), csv([row(), row()]), csv([row('', { 中文品名: 'Missing license' })]), Buffer.from([0xff, 0xfe])]) {
    assert.throws(() => importAppearance(db, data, 'invalid.csv'));
    assert.deepEqual(getTfda(db, 'TEST001'), before);
  }
  const zip = new AdmZip(); zip.addFile('first.csv', csv([row()])); zip.addFile('second.csv', csv([row()]));
  assert.throws(() => importAppearance(db, zip.toBuffer(), 'invalid.zip'), /只包含一份/);
  assert.equal(datasetStatus(db).find(item => item.source === 'tfda_appearance')!.count, 1);
});

test('Untrusted image links are not exposed as clickable source images', t => {
  const db = database(t);
  importAppearance(db, csv([row('TEST001', { 外觀圖檔連結: 'javascript:alert(1);;;https://fda.gov.tw.attacker.example/a;;;https://user:secret@mcp.fda.gov.tw/a;;;https://mcp.fda.gov.tw/valid' })]), 'links.csv');
  assert.deepEqual(getTfda(db, 'TEST001')!.appearance!.imageUrls, ['https://mcp.fda.gov.tw/valid']);
});

test('Chinese and English observations search local records and keep multiple candidates', t => {
  const db = seed(t);
  importAppearance(db, csv([row(), row('TEST002')]), 'two.csv');
  for (const name of ['測試錠', 'synthetic tablet', 'ＳＹＮＴＨＥＴＩＣ ＴＡＢＬＥＴ']) {
    const match = matchObservation(db, observe(undefined, name));
    assert.equal(match.matchedBy, 'name'); assert.equal(match.total, 2);
  }
  assert.equal(searchTfda(db, '%').length, 0);
  assert.equal(searchTfda(db, "' OR 1=1 --").length, 0);
});

test('Appearance choices follow the installed snapshot and retain every selected color and imprint over HTTP', async t => {
  const db = database(t); let externalCalls = 0;
  const app = express(); app.use(express.json());
  app.use('/meds', medicationRouter(db, new DrugProviders(db, (async () => { externalCalls++; throw Error('Must stay local'); }) as typeof fetch)));
  const server = await listenForFetch(app);
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/meds`;
  const options = async () => (await (await fetch(`${base}/status`)).json()).appearanceOptions;
  assert.deepEqual(await options(), { shapes: [], colors: [] });
  importAppearance(db, csv([
    row('PINK', { 顏色: '粉色' }),
    row('DUAL', { 顏色: '紅;;;白', 形狀: '膠囊' }),
    row('RED', { 顏色: '紅', 形狀: '膠囊' }),
    row('POWDER', { 顏色: '白', 形狀: '粉劑或散劑' }),
    row('LIQUID', { 顏色: '透明', 形狀: '液劑(包含糖漿用粉劑)' }),
  ]), 'synthetic.csv');
  const before = db.prepare('SELECT * FROM tfda_appearances ORDER BY id').all();
  const choices = await options();
  assert.deepEqual(new Set(choices.shapes), new Set(['圓形', '膠囊', '粉劑或散劑', '液劑(包含糖漿用粉劑)']));
  assert.deepEqual(new Set(choices.colors), new Set(['粉', '紅', '白', '透明']));
  const match = async (shape: string, color: string, imprints: string[] = []) => (await (await fetch(`${base}/match`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ observations: [observe({ shape, color, imprints })] }),
  })).json()).matches[0];
  assert.deepEqual((await match('圓形', '粉')).candidates.map((d: { id: string }) => d.id), ['PINK']);
  assert.deepEqual((await match('膠囊', '紅、白', ['FY T061'])).candidates.map((d: { id: string }) => d.id), ['DUAL']);
  assert.equal((await match('膠囊', '紅、白', ['FY'])).total, 0);
  assert.equal((await match('圓形', '粉紅色')).total, 0, 'choices must not silently broaden free text');
  assert.deepEqual(db.prepare('SELECT * FROM tfda_appearances ORDER BY id').all(), before);
  assert.throws(() => importAppearance(db, csv([row(), row()]), 'invalid.csv'));
  assert.deepEqual(await options(), choices);
  importAppearance(db, csv([row('UPDATED', { 顏色: '藍', 形狀: '橢圓形' })]), 'updated.csv');
  assert.deepEqual(await options(), { shapes: ['橢圓形'], colors: ['藍'] });
  assert.equal(externalCalls, 0);
});

test('Full imprints match with normalized spaces and either face, without substring or relaxed color matches', t => {
  const db = seed(t);
  const query = (imprints: string[], color = '白色', shape = '圓形') => matchObservation(db, observe({ color, shape, imprints }));
  assert.equal(query(['２５', 'fy t061']).total, 1);
  assert.equal(query(['T061']).total, 0);
  assert.equal(query(['FY T061'], '紅').total, 0);
  assert.equal(query(['FY T061'], '白', '橢圓形').total, 0);
  importAppearance(db, csv([row('TEST001', { 標註一: 'AB/25', 標註二: '' })]), 'symbol.csv');
  assert.equal(query(['AB']).total, 0);
  assert.equal(query(['AB/25']).total, 1);
});

test('Broad appearances remain bounded and missing features do not list arbitrary drugs', t => {
  const db = database(t);
  importAppearance(db, csv(Array.from({ length: 25 }, (_, i) => row(`TEST${i}`))), 'many.csv');
  const matches = matchObservation(db, observe({ shape: '圓形', color: '白', imprints: [] }));
  assert.equal(matches.total, 25); assert.equal(matches.candidates.length, 20); assert.match(matches.warnings.join(''), /25 個候選/);
  assert.equal(matchObservation(db, observe({ shape: '', color: '白', imprints: [] })).matchedBy, 'insufficient');
  assert.equal(matchObservation(db, observe()).total, 0);
  assert.equal(validObservations([observe()]), true);
  assert.equal(validObservations(Array(7).fill(observe())), false);
  assert.equal(validObservations([observe({ shape: '', color: '', imprints: ['a', 'b', 'c'] })]), false);
});

test('Local report makes zero provider requests and distinguishes unrequested labels from no matches', async t => {
  const db = seed(t); let calls = 0;
  const providers = new DrugProviders(db, (async () => { calls++; throw new Error('Network must not be used'); }) as typeof fetch);
  const report = await providers.report([getTfda(db, 'TEST001')!], 'local');
  assert.equal(calls, 0); assert.equal(report.mode, 'local');
  assert.equal(report.interactions[0].level, 'Major'); assert.equal(report.medications[0].labelStatus, 'not_requested');
  const markdown = reportToMarkdown(report);
  assert.match(markdown, /尚未查詢線上仿單/); assert.match(markdown, /FY T061/);
  assert.match(markdown, /data.gov.tw\/dataset\/9120/); assert.doesNotMatch(markdown, /未查得符合成分的資料/);
  assert.match(summarizeMedicationReport(report), /本機模式未查詢線上仿單的品項數：1/);
  await providers.report([getTfda(db, 'TEST001')!], 'online');
  assert.ok(calls > 0);
});

test('New local API flow covers candidates and reports without calling online search or trusting client ingredients', async t => {
  const db = seed(t); let calls = 0;
  const provider = new DrugProviders(db, (async () => { calls++; throw new Error('Unexpected online call'); }) as typeof fetch);
  const app = express(); app.use(express.json()); app.use('/api/medications', medicationRouter(db, provider));
  const server = await listenForFetch(app);
  const port = (server.address() as { port: number }).port;
  const post = (route: string, body: unknown) => fetch(`http://127.0.0.1:${port}/api/medications/${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const matched = await (await post('match', { observations: [observe({ shape: '圓形', color: '白', imprints: ['FY T061'] })] })).json();
    assert.equal(matched.matches[0].candidates[0].id, 'TEST001');
    const report = await (await post('report', { drugs: [{ source: 'tfda', id: 'TEST001', ingredients: ['Fake'] }] })).json();
    assert.equal(report.mode, 'local'); assert.equal(report.medications[0].ingredients[0].original, 'Alpha');
    assert.equal((await post('report', { drugs: [{ source: 'rxnorm', id: '1' }] })).status, 400);
    assert.equal((await post('report', { drugs: [{ source: 'tfda', id: 'TEST001' }], mode: 'unknown' })).status, 400);
    assert.equal((await post('match', { observations: [{ name: 'x', appearance: { imprints: 'broken' } }] })).status, 400);
    assert.equal(calls, 0);
  } finally { server.close(); await once(server, 'close'); }
});

test('Photo extraction passes named packaging and unnamed pill features to local matching without guessing names', async t => {
  const db = seed(t); let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    requests++;
    return new Response(JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: JSON.stringify({ medications: [
      { name: 'SYNTHETIC TABLET', strength: '1 mg', dosageForm: 'tablet' },
      { name: '', strength: '', dosageForm: '', appearance: { shape: '圓形', color: '白', imprints: ['FY T061'] } },
    ] }) }] }, finishReason: 'STOP' }] }), { headers: { 'Content-Type': 'application/json' } });
  });
  const observations = await extractMedicationNames(['data:image/png;base64,AA=='], 'synthetic-test-key-not-a-credential');
  assert.equal(observations[1].name, '');
  const matches = observations.map(observation => matchObservation(db, observation));
  assert.deepEqual(matches.map(match => match.matchedBy), ['name', 'appearance']);
  assert.equal(matches[0].total, 0, 'a name without a recorded strength cannot satisfy the observed 1 mg');
  assert.match(matches[0].warnings.join(''), /品名未記載規格/);
  assert.equal(matches[1].candidates[0].id, 'TEST001');
  assert.equal(requests, 1);
});
