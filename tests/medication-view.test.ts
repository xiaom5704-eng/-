import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DrugCandidate, InteractionEvidence, MedicationReport, ResolvedIngredient } from '../shared/medication';
import { ingredientName, interactionGroups, reportMatchesSelection } from '../shared/medication-view';
import type { MedicationPatient } from '../shared/medication-safety';

const ingredient = (original: string, name: string, rxCui: string): ResolvedIngredient => ({ original, name, rxCui, mapping: 'rxnorm' });
const a = ingredient('A original', 'alpha', '1');
const b = ingredient('B original', 'beta', '2');
const aliasA = ingredient('A alternate', 'alpha', '1');
const pair: InteractionEvidence = { drugA: 'One', drugB: 'Two', ingredientA: a.original, ingredientB: b.original, status: 'found', level: 'Unknown', scope: 'between_products', sourceUrl: 'https://example.test' };
function report(pairs: InteractionEvidence[]): MedicationReport {
  return { checkedAt: '', datasets: [], limitations: [], interactions: pairs,
    medications: [['One', [a, b]], ['Two', [aliasA, b]]].map(([name, ingredients]) => ({ drug: { name } as DrugCandidate, ingredients: ingredients as ResolvedIngredient[], warnings: [], labels: [], labelStatus: 'not_found' })),
  };
}

test('Repeated reverse-direction findings collapse without dropping original evidence or changing risk', () => {
  const original = report([pair, { ...pair, ingredientA: b.original, ingredientB: aliasA.original }]);
  const before = JSON.stringify(original);
  const groups = interactionGroups(original);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].pairs.length, 2);
  assert.equal(groups[0].level, 'Unknown');
  assert.deepEqual(groups[0].drugs, ['One', 'Two']);
  assert.equal(JSON.stringify(original), before);
});

test('Internal pairs, different risk levels and unresolved statuses never merge', () => {
  const pairs: InteractionEvidence[] = [pair,
    { ...pair, drugB: 'One', scope: 'within_product' },
    { ...pair, level: 'Major' },
    { ...pair, status: 'not_found', level: undefined },
    { ...pair, status: 'unmapped', level: undefined },
  ];
  const groups = interactionGroups(report(pairs));
  assert.equal(groups.length, 5);
  assert.equal(groups.flatMap(g => g.pairs).length, pairs.length);
  assert.equal(groups.filter(g => g.internal).length, 1);
  assert.ok(groups.some(g => g.status === 'unmapped'));
});

test('Duplicate ingredients show one name while preserving the two original spellings', () => {
  const groups = interactionGroups(report([{ ...pair, ingredientB: aliasA.original, status: 'duplicate', level: undefined }]));
  assert.deepEqual(groups[0].names, ['alpha']);
  assert.equal(groups[0].pairs[0].ingredientA, 'A original');
  assert.equal(groups[0].pairs[0].ingredientB, 'A alternate');
});

test('Ambiguous product identities and unknown display names are not guessed', () => {
  const value = report([pair]);
  value.medications.push({ ...value.medications[0], ingredients: [ingredient(a.original, 'unrelated', '999')] });
  assert.ok(interactionGroups(value)[0].names.includes(a.original));
  assert.equal(ingredientName({ name: 'acetaminophen' }), '乙醯胺酚');
  assert.equal(ingredientName({ name: 'caffeine' }), '咖啡因');
  assert.equal(ingredientName({ name: 'caffeine citrate' }), 'caffeine citrate');
  assert.deepEqual(interactionGroups(report([])), []);
});

test('A failed refresh can retain an earlier result only for the same products and patient', () => {
  const patient: MedicationPatient = { age: { value: '1', unit: 'months' }, premature: 'unknown' };
  const selected = [{ source: 'tfda' as const, id: 'QA001' }, { source: 'tfda' as const, id: 'QA002' }];
  const value: MedicationReport = { ...report([]),
    medications: selected.map((drug, i) => ({ ...report([]).medications[i], drug: { ...report([]).medications[i].drug, ...drug } })),
    safety: { patient, alerts: [], reviewedAt: '', uncoveredDrugNames: [], limitations: [] },
  };
  assert.equal(reportMatchesSelection(value, selected, patient), true);
  assert.equal(reportMatchesSelection(value, selected, { ...patient, age: { value: '1', unit: 'years' } }), false);
  assert.equal(reportMatchesSelection(value, selected, { ...patient, age: { value: '30', unit: 'days' } }), false);
  assert.equal(reportMatchesSelection(value, selected, { ...patient, premature: 'yes' }), false);
  assert.equal(reportMatchesSelection(value, selected, { ...patient, age: { value: '', unit: 'months' } }), false);
  assert.equal(reportMatchesSelection(value, selected.slice(0, 1), patient), false);
  assert.equal(reportMatchesSelection(value, [...selected].reverse(), patient), false);
  assert.equal(reportMatchesSelection(value, [selected[0], { source: 'rxnorm', id: 'QA002' }], patient), false);
  assert.equal(reportMatchesSelection(value, [selected[0], { source: 'tfda', id: 'QA003' }], patient), false);
  assert.equal(reportMatchesSelection({ ...value, safety: undefined }, selected, patient), false);
  assert.equal(reportMatchesSelection(null, selected, patient), false);
  assert.equal(reportMatchesSelection(value, selected, patient, 'demo'), false);
  const demo = { id: 'demo', title: '', description: '', sourceUrl: '', notes: [] };
  assert.equal(reportMatchesSelection({ ...value, demo }, selected, patient, 'demo'), true);
  assert.equal(reportMatchesSelection({ ...value, demo }, selected, patient), false);
});
