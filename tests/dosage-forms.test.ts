import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { listenForFetch } from './http-listener';
import express from 'express';
import { openDrugDatabase, searchLocalCandidates } from '../server/medications/store';
import { importTfda } from '../server/medications/importers';
import { importAppearance, matchObservation } from '../server/medications/appearance';
import { dosageFormSearchNotice, localDosageForms } from '../server/medications/dosage-forms';
import { SearchSnapshotChanged } from '../server/medications/search-index';
import { medicationRouter } from '../server/medications/router';
import { DrugProviders } from '../server/medications/providers';

const row = (id: string, form: string, strength = '1mg') => ({ 許可證字號: id, 中文品名: `人工測試藥${strength}`, 英文品名: `SYNTHETIC ${strength}`, 劑型: form, 主成分略述: 'Alpha' });
const database = (t: TestContext) => { const db = openDrugDatabase(':memory:'); t.after(() => db.close()); return db; };

test('Dosage form constraints keep source subtypes, routes and release descriptors distinct', t => {
  const db = database(t);
  const forms = ['錠劑', '膜衣錠', '腸溶錠', '持續性藥效錠', '內服液劑', '口服液劑', '外用液劑'];
  importTfda(db, forms.map((form, i) => row(String(i), form)));
  for (const [form, expected] of [['錠劑', '0'], [' TABLETS ', '0'], ['Film-Coated Tablets', '1'], ['腸溶錠', '2'], ['持續性藥效錠', '3'],
    ['solution for internal use', '4'], ['oral solution', '5'], ['solution for external use', '6']]) {
    assert.deepEqual(searchLocalCandidates(db, 'synthetic', undefined, { dosageForm: form }).candidates.map(d => d.id), [expected], form);
  }
  assert.equal(searchLocalCandidates(db, 'synthetic').total, 7);
  for (const form of ['extended release tablet', '液劑', '未知劑型', "' OR 1=1 --"]) {
    assert.equal(searchLocalCandidates(db, 'synthetic', undefined, { dosageForm: form }).total, 0);
    assert.match(dosageFormSearchNotice(db, form).join(''), /尚無本機欄位對照/);
  }
  assert.equal(searchLocalCandidates(db, 'synthetic', undefined, { dosageForm: ' ' }).total, 7);
});

test('Scanned name, strength, form and imprint must all agree with current source fields', t => {
  const db = database(t);
  importTfda(db, [row('MATCH', '膜衣錠'), row('WRONG_FORM', '錠劑'), row('WRONG_STRENGTH', '膜衣錠', '5mg'),
    row('WRONG_IMPRINT', '膜衣錠'), { ...row('MISSING_FORM', ''), 申請商名稱: '膜衣錠工廠' }]);
  const ids = ['MATCH', 'WRONG_FORM', 'WRONG_STRENGTH', 'WRONG_IMPRINT', 'MISSING_FORM', 'APPEARANCE_ONLY'];
  importAppearance(db, Buffer.from(['許可證字號,中文品名,英文品名,形狀,特殊劑型,顏色,特殊氣味,刻痕,外觀尺寸,標註一,標註二,外觀圖檔連結',
    ...ids.map(id => `${id},人工測試藥1mg,SYNTHETIC 1mg,圓形,膜衣錠,白,,,8,${id === 'WRONG_IMPRINT' ? 'XY' : 'AB'},,`)].join('\n')), 'synthetic.csv');
  const observation = { name: 'synthetic', strength: '1mg', dosageForm: 'film-coated tablet', appearance: { shape: '圓形', color: '白', imprints: ['AB'] } };
  assert.deepEqual(matchObservation(db, observation).candidates.map(d => d.id), ['MATCH']);
  assert.match(matchObservation(db, observation).warnings.join(''), /劑型依來源欄位篩選：膜衣錠/);
  assert.equal(matchObservation(db, { ...observation, dosageForm: '' }).total, 4, 'clearing the form preserves name, strength and imprint constraints');
});

test('Import refreshes dosage form choices and rejects previous candidate pages', t => {
  const db = database(t);
  importTfda(db, Array.from({ length: 23 }, (_, i) => row(`T${i}`, '膜衣錠')));
  assert.deepEqual(localDosageForms(db), ['膜衣錠']);
  const first = searchLocalCandidates(db, 'synthetic1mg', undefined, { dosageForm: '膜衣錠' });
  const second = searchLocalCandidates(db, 'synthetic1mg', undefined, { dosageForm: '膜衣錠', offset: 20, revision: first.page.revision });
  assert.equal(second.total, 23); assert.equal(second.candidates.length, 3);
  assert.equal(new Set([...first.candidates, ...second.candidates].map(d => d.id)).size, 23);
  importTfda(db, [row('NEW', '口服液劑')]);
  assert.deepEqual(localDosageForms(db), ['口服液劑']);
  assert.equal(searchLocalCandidates(db, 'synthetic', undefined, { dosageForm: '膜衣錠' }).total, 0);
  assert.throws(() => searchLocalCandidates(db, 'synthetic', undefined, { dosageForm: '膜衣錠', offset: 20, revision: first.page.revision }), SearchSnapshotChanged);
});

test('HTTP manual and scanned form searches agree, expose source choices, and stay local', async t => {
  const db = database(t); let calls = 0;
  importTfda(db, [row('FILM', '膜衣錠'), row('PLAIN', '錠劑')]);
  const app = express(); app.use(express.json());
  app.use('/meds', medicationRouter(db, new DrugProviders(db, (async () => { calls++; throw new Error('Must remain local'); }) as typeof fetch)));
  const server = await listenForFetch(app);
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/meds`;
  const status = await (await fetch(`${base}/status`)).json();
  assert.deepEqual(new Set(status.dosageForms), new Set(['膜衣錠', '錠劑']));
  const result = await (await fetch(`${base}/search?${new URLSearchParams({ q: 'synthetic1mg', dosageForm: '膜衣錠' })}`)).json();
  const scanned = await (await fetch(`${base}/match`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ observations: [{ name: 'synthetic', strength: '1mg', dosageForm: 'film-coated tablets' }] }) })).json();
  assert.deepEqual(result.candidates.map((d: { id: string }) => d.id), ['FILM']);
  assert.deepEqual(scanned.matches[0].candidates, result.candidates);
  const unknown = await (await fetch(`${base}/search?q=synthetic&dosageForm=unknown`)).json();
  assert.equal(unknown.total, 0); assert.match(unknown.warnings.join(''), /校正或清空/);
  for (const suffix of ['dosageForm=tablet&source=rxnorm', 'dosageForm=a&dosageForm=b', `dosageForm=${'x'.repeat(121)}`]) {
    assert.equal((await fetch(`${base}/search?q=synthetic&${suffix}`)).status, 400, suffix);
  }
  assert.equal(calls, 0);
});
