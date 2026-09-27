import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { once } from 'node:events';
import { listenForFetch } from './http-listener';
import { caseProducts, evaluateMedicationSafety, infantDemo, matchesCaseProduct, underYears, validMedicationPatient, type MedicationPatient } from '../shared/medication-safety';
import { reportToMarkdown, type DrugCandidate } from '../shared/medication';
import { summarizeMedicationReport } from '../shared/medication-summary';
import { openDrugDatabase, searchTfda } from '../server/medications/store';
import { importTfda } from '../server/medications/importers';
import { DrugProviders } from '../server/medications/providers';
import { medicationRouter } from '../server/medications/router';
import { verifiedProductLabel } from '../server/medications/verified-names';

// Synthetic fixtures use the reviewed IDs to exercise rules, never imported into production.
const drugs: DrugCandidate[] = caseProducts.map(spec => ({ source: 'tfda', id: spec.id, name: `測試 ${spec.articleName}`, englishName: spec.articleName,
  ingredients: [...spec.ingredients], dosageForm: '', manufacturer: '', licenseStatus: '', validUntil: '', indications: '', dosageText: '', sourceUrl: 'https://data.gov.tw/dataset/9122' }));
const patient = (value = '1', unit: MedicationPatient['age']['unit'] = 'months', premature: MedicationPatient['premature'] = 'unknown'): MedicationPatient => ({ age: { value, unit }, premature });
const evaluate = (value = '1', unit: MedicationPatient['age']['unit'] = 'months', premature: MedicationPatient['premature'] = 'unknown') => evaluateMedicationSafety(drugs, patient(value, unit, premature));

test('One calendar month does not automatically satisfy a neonatal contraindication', () => {
  const result = evaluate();
  assert.equal(result.alerts.some(a => a.kind === 'contraindication'), false);
  for (const id of ['confirm-day-age', 'confirm-prematurity', 'cypromin-under2', 'somin-under3', 'noscapine-under3', 'kbt-child', 'fencaine-gap', 'sedation-overlap']) assert.ok(result.alerts.some(a => a.id === id));
  assert.ok(result.uncoveredDrugNames.includes('測試 Fencaine'));
});
test('Explicit neonatal day boundary is 27 / 28, not one month', () => {
  assert.ok(evaluate('27', 'days', 'no').alerts.some(a => a.id === 'cypromin-neonate'));
  assert.equal(evaluate('28', 'days', 'no').alerts.some(a => a.kind === 'contraindication'), false);
  assert.ok(evaluate('28', 'days', 'no').alerts.some(a => a.id === 'cypromin-under2'));
  assert.equal(evaluate('31', 'days', 'no').alerts.some(a => a.id === 'confirm-day-age'), false);
});
test('Birthday boundaries stay uncertain with days; age validation rejects malformed requests', () => {
  assert.equal(underYears({ value: '729', unit: 'days' }, 2), true);
  assert.equal(underYears({ value: '730', unit: 'days' }, 2), undefined);
  assert.equal(underYears({ value: '732', unit: 'days' }, 2), false);
  for (const value of [null, {}, { age: {} }, patient('-1'), patient('1.5'), patient('Infinity'), patient('131', 'years'), { ...patient(), premature: true }, { ...patient(), age: { value: '1', unit: 'weeks' } }]) assert.equal(validMedicationPatient(value), false);
  assert.ok(validMedicationPatient(patient('', 'years')));
  assert.ok(validMedicationPatient(patient('0', 'days')));
});
test('Age thresholds and unfilled age do not leak infant alerts into older patients', () => {
  assert.ok(evaluate('23').alerts.some(a => a.id === 'cypromin-under2'));
  assert.equal(evaluate('24').alerts.some(a => a.id === 'cypromin-under2'), false);
  assert.ok(evaluate('35').alerts.some(a => a.id === 'somin-under3'));
  assert.equal(evaluate('36').alerts.some(a => a.id === 'somin-under3'), false);
  for (const result of [evaluate('4', 'years'), evaluate('30', 'years'), evaluate('70', 'years'), evaluate('', 'years')]) {
    assert.equal(result.alerts.some(a => /under[23]|neonate|confirm-day|prematurity/.test(a.id)), false);
    assert.ok(result.alerts.some(a => a.id === 'sedation-overlap'));
  }
  assert.ok(evaluate('70', 'years').alerts.some(a => a.id === 'cypromin-older'));
  assert.equal(evaluate('30', 'years').alerts.some(a => a.id === 'cypromin-older'), false);
});
test('Prematurity history prompts review, not an automatic lifelong contraindication', () => {
  assert.ok(evaluate('1', 'months', 'yes').alerts.some(a => a.id === 'confirm-prematurity'));
  assert.equal(evaluate('1', 'months', 'no').alerts.some(a => a.id === 'confirm-prematurity'), false);
  assert.equal(evaluate('30', 'years', 'yes').alerts.some(a => a.kind === 'contraindication'), false);
});

test('Somin senior advice follows its reviewed Taiwan leaflet and does not invent a contraindication', () => {
  for (const [value, unit, expected] of [
    ['64', 'years', false], ['65', 'years', true], ['779', 'months', false], ['780', 'months', true],
    ['23725', 'days', false], ['23790', 'days', true], ['', 'years', false],
  ] as const) {
    const alert = evaluate(value, unit).alerts.find(a => a.id === 'somin-older');
    assert.equal(!!alert, expected);
    if (alert) { assert.equal(alert.kind, 'review'); assert.match(alert.sources[0].url, /^https:\/\/mcp\.fda\.gov\.tw\/fileshow\//); }
  }
  const changed = { ...drugs[1], ingredients: ['UNRELATED'] };
  assert.equal(evaluateMedicationSafety([changed], patient('70', 'years')).alerts.length, 0);
  assert.match(evaluate().alerts.find(a => a.id === 'fencaine-gap')!.sources[0].version, /歷史/);
});
test('Rules require the exact license and complete ingredient set, not a similar brand', () => {
  for (const changed of [{ ...drugs[2], id: '衛署藥製字第009386號' }, { ...drugs[2], ingredients: ['CYPROHEPTADINE HCL', 'OTHER'] }, { ...drugs[2], source: 'rxnorm' as const }]) {
    assert.equal(matchesCaseProduct(changed, caseProducts[2]), false);
    const result = evaluateMedicationSafety([changed], patient('20', 'days'));
    assert.equal(result.alerts.length, 0);
    assert.equal(result.uncoveredDrugNames.length, 1);
  }
  assert.equal(evaluateMedicationSafety([drugs[1]], patient()).alerts.some(a => a.id === 'sedation-overlap'), false);
});
test('Reviewed Taiwan leaflet links remain license-scoped and label their version', () => {
  assert.match(verifiedProductLabel(drugs[2])!.title, /2012-02-22/);
  assert.match(verifiedProductLabel(drugs[3])!.title, /2023-02-24/);
  assert.match(verifiedProductLabel(drugs[1])!.title, /2022-04-26/);
  assert.match(verifiedProductLabel(drugs[4])!.title, /歷史仿單/);
  for (const drug of [drugs[1], drugs[4]]) assert.equal(verifiedProductLabel({ ...drug, ingredients: ['UNRELATED'] }), undefined);
  assert.equal(verifiedProductLabel({ source: 'tfda', id: '衛署藥製字第009386號' }), undefined);
  assert.equal(verifiedProductLabel({ source: 'rxnorm', id: drugs[2].id }), undefined);
});
test('Local report does not make external calls or manufacture DDInter matches; export retains evidence', async () => {
  const db = openDrugDatabase(':memory:'); let calls = 0;
  try {
    const providers = new DrugProviders(db, (async () => { calls++; throw new Error('network disabled'); }) as typeof fetch);
    const report = await providers.report(drugs, 'local', patient()); report.demo = infantDemo;
    const adult = await providers.report(drugs, 'local', patient('30', 'years'));
    assert.equal(calls, 0);
    assert.deepEqual(report.interactions, adult.interactions);
    assert.equal(report.interactions.length, 28);
    assert.ok(report.interactions.every(pair => pair.status === 'not_imported'));
    const markdown = reportToMarkdown(report);
    assert.match(markdown, /1 個月/); assert.match(markdown, /來源推論/); assert.match(markdown, /cth.org.tw/); assert.match(markdown, /未證實為原處方/);
    assert.match(summarizeMedicationReport(report), /先確認實際日齡/);
  } finally { db.close(); }
});
test('Demo API fails closed on missing products, validates patient and preserves demo identity across ages', async () => {
  const db = openDrugDatabase(':memory:');
  const providers = new DrugProviders(db, (async () => { throw new Error('external fetch prohibited'); }) as typeof fetch);
  const app = express(); app.use(express.json()); app.use('/meds', medicationRouter(db, providers));
  const server = await listenForFetch(app);
  const base = `http://127.0.0.1:${(server.address() as any).port}/meds`;
  const post = (route: string, body = {}) => fetch(`${base}/${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    assert.equal((await post('demo')).status, 409);
    importTfda(db, drugs.map(drug => ({ 許可證字號: drug.id, 中文品名: drug.name, 英文品名: drug.englishName, 主成分略述: drug.ingredients.join(';;') })));
    const response = await post('demo'); assert.equal(response.status, 200);
    const demo = await response.json(); assert.equal(demo.medications.length, 5); assert.equal(demo.demo.id, infantDemo.id); assert.equal(demo.mode, 'local');
    const selections = drugs.map(({ source, id }) => ({ source, id }));
    assert.equal((await post('report', { drugs: selections, patient: { age: { value: '1', unit: 'weeks' } } })).status, 400);
    const adult = await (await post('report', { drugs: selections, patient: patient('30', 'years'), demoId: infantDemo.id })).json();
    assert.equal(adult.demo.id, infantDemo.id); assert.equal(adult.safety.patient.age.value, '30');
    const changed = await (await post('report', { drugs: selections.slice(0, 1), patient: patient(), demoId: infantDemo.id })).json();
    assert.equal(changed.demo, undefined);
    db.prepare('DELETE FROM tfda_drugs WHERE id = ?').run(drugs[0].id);
    assert.equal((await post('demo')).status, 409);
  } finally { server.close(); await once(server, 'close'); db.close(); }
});
test('Whole leading brand token ranks before a name containing the same substring', () => {
  const db = openDrugDatabase(':memory:');
  try {
    importTfda(db, [{ 許可證字號: 'X1', 中文品名: 'A 不同藥', 英文品名: 'ESOMIN TABLETS', 主成分略述: 'Estazolam' }, { 許可證字號: 'X2', 中文品名: 'Z 目標藥', 英文品名: 'SOMIN TABLETS 2MG', 主成分略述: 'Dexchlorpheniramine maleate' }]);
    assert.equal(searchTfda(db, 'somin')[0].id, 'X2');
    assert.equal(searchTfda(db, 'somin')[1].id, 'X1');
    assert.equal(searchTfda(db, 'somin%').length, 0);
  } finally { db.close(); }
});
