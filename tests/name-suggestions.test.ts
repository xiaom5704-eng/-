import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { canSuggestName, oneNameEdit } from '../shared/name-suggestions';
import { suggestLocalNames } from '../server/medications/name-suggestions';
import { openDrugDatabase, searchLocalCandidates } from '../server/medications/store';
import { importTfda } from '../server/medications/importers';
import { importAppearance } from '../server/medications/appearance';
import { medicationRouter } from '../server/medications/router';
import { DrugProviders } from '../server/medications/providers';
import { listenForFetch } from './http-listener';

const row = (id: string, name: string, english: string, form = '錠劑') => ({ 許可證字號: id, 中文品名: name, 英文品名: english,
  主成分略述: 'IngredientOnly', 申請商名稱: 'ManufacturerOnly', 劑型: form, 註銷狀態: '' });
const database = (t: TestContext) => { const db = openDrugDatabase(':memory:'); t.after(() => db.close()); return db; };

test('Name edits allow one typo or transposition but never change measurements or short ambiguous input', () => {
  for (const [a, b] of [['somni', 'somin'], ['smin', 'somin'], ['sommin', 'somin'], ['somln', 'somin']]) assert.ok(oneNameEdit(a, b));
  for (const [a, b] of [['somin', 'somin'], ['someni', 'somin'], ['abcd', 'badc']]) assert.equal(oneNameEdit(a, b), false);
  for (const input of ['Somni', '普拿痛', 'ＳＯＭＮＩ']) assert.ok(canSuggestName(input));
  for (const input of ['AB', 'FC10', 'Somin 2mg', 'Somin 2 mg', '0.4mg/ml', 'I.5mg', '第001號', 'a%bc', 'a_bc', 'a'.repeat(33), '普拿疼\n錠']) assert.equal(canSuggestName(input), false, input);
});

test('A zero-result typo offers source spellings without changing the exact query or choosing a product', t => {
  const db = database(t);
  importTfda(db, [row('A', '人工甲', 'SOMIN TABLETS'), row('B', '人工乙', 'SOMMI TABLETS')]);
  assert.equal(searchLocalCandidates(db, 'somni').total, 0);
  assert.deepEqual(new Set(suggestLocalNames(db, 'somni').suggestions), new Set(['SOMIN', 'SOMMI']));
  assert.equal(searchLocalCandidates(db, 'somni').total, 0);
  assert.deepEqual(suggestLocalNames(db, 'SOMIN').suggestions, []);
  assert.deepEqual(searchLocalCandidates(db, 'SOMIN').candidates.map(d => d.id), ['A']);
  assert.deepEqual(suggestLocalNames(db, 'szzmin').suggestions, []);
});

test('Chinese spelling suggestions keep source characters and do not drop the selected dosage form', t => {
  const db = database(t);
  importTfda(db, [row('A', '人工普拿疼加強錠', 'SOMIN TABLETS'), row('B', '人工甲液', 'ALPHA SOLUTION', '內服液劑')]);
  assert.ok(suggestLocalNames(db, '普拿痛').suggestions.includes('普拿疼'));
  assert.deepEqual(suggestLocalNames(db, 'somni', '錠劑').suggestions, ['SOMIN']);
  assert.deepEqual(suggestLocalNames(db, 'somni', '內服液劑').suggestions, []);
  assert.deepEqual(suggestLocalNames(db, 'somni', 'unknown').suggestions, []);
  assert.deepEqual(suggestLocalNames(db, 'somni 2mg').suggestions, []);
});

test('Suggestions only use recorded product names, including appearance-only names', t => {
  const db = database(t);
  importTfda(db, [row('A', '人工甲', 'SOMIN TABLETS')]);
  importAppearance(db, Buffer.from('許可證字號,中文品名,英文品名,形狀,特殊劑型,顏色,特殊氣味,刻痕,外觀尺寸,標註一,標註二,外觀圖檔連結\nVISUAL,人工外觀,VISUALNAME,圓形,,白,,,8,IMPRINTONLY,,'), 'synthetic.csv');
  assert.deepEqual(suggestLocalNames(db, 'Visualnmae').suggestions, ['VISUALNAME']);
  for (const input of ['IngredientOnyl', 'ManufacturerOnyl', 'ImprintOnyl']) assert.deepEqual(suggestLocalNames(db, input).suggestions, []);
});

test('Importing new source names invalidates cached suggestions and removes old names', t => {
  const db = database(t);
  importTfda(db, [row('A', '人工甲', 'SOMIN TABLETS')]);
  assert.deepEqual(suggestLocalNames(db, 'somni').suggestions, ['SOMIN']);
  importTfda(db, [row('B', '人工乙', 'SOMMI TABLETS')]);
  assert.deepEqual(suggestLocalNames(db, 'somni').suggestions, ['SOMMI']);
});

test('Suggestion endpoint stays local, validates request types, and preserves search behavior', async t => {
  const db = database(t); let externalCalls = 0;
  importTfda(db, [row('A', '人工甲', 'SOMIN TABLETS')]);
  const app = express(); app.use('/meds', medicationRouter(db, new DrugProviders(db, (async () => { externalCalls++; throw Error('No network'); }) as typeof fetch)));
  const server = await listenForFetch(app);
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/meds`;
  assert.deepEqual(await (await fetch(`${base}/name-suggestions?q=somni`)).json(), { suggestions: ['SOMIN'] });
  assert.equal((await (await fetch(`${base}/search?q=somni`)).json()).total, 0);
  assert.deepEqual(await (await fetch(`${base}/name-suggestions?q=FC10`)).json(), { suggestions: [] });
  for (const query of ['q=somni&q=somin', 'q=somni&dosageForm=a&dosageForm=b', `q=${'a'.repeat(121)}`, ''])
    assert.equal((await fetch(`${base}/name-suggestions?${query}`)).status, 400);
  assert.equal(externalCalls, 0);
});
