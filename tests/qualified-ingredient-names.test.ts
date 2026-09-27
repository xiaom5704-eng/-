import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { openDrugDatabase } from '../server/medications/store';
import { importDdinter } from '../server/medications/importers';
import { DrugProviders, ingredientLookup } from '../server/medications/providers';
import { verifiedIngredientName } from '../server/medications/verified-names';
import { writeIngredientRecord } from '../server/medications/ingredient-registry';

test('Reviewed qualification keeps the complete salt name and refuses unrelated qualifiers', () => {
  assert.equal(verifiedIngredientName('GENTAMICIN (AS SULFATE)')?.name, 'GENTAMICIN SULFATE');
  assert.equal(verifiedIngredientName(' neomycin  (sulfate) ')?.name, 'NEOMYCIN SULFATE');
  assert.equal(verifiedIngredientName('AMOXICILLIN (TRIHYDRATE)')?.name, 'AMOXICILLIN TRIHYDRATE');
  for (const name of ['UNKNOWN (AS SULFATE)', 'GENTAMICIN (0.3%)', 'GENTAMICIN (OPHTHALMIC)', 'GENTAMICIN (SULFATE) 10 MG',
    'GENTAMICIN (AS SULFATE) + NEOMYCIN', 'NIACIN (NIACINAMIDE)', 'IODINE (POVIDONE)', 'BETAMETHASONE (ACETATE + PHOSPHATE)'])
    assert.equal(verifiedIngredientName(name), undefined, name);
});

// Synthetic DDInter pair tests matching only; it is not clinical source evidence.
test('An empty local registry can use the shipped exact PIN relation without a network call or data writes', async () => {
  const db = openDrugDatabase(':memory:');
  try {
    importDdinter(db, [{ name: 'synthetic.csv', csv: 'DDInterID_A,Drug_A,DDInterID_B,Drug_B,Level\nDDInter1,Gentamicin,DDInter2,Other,Unknown\n' }]);
    const provider = new DrugProviders(db, async () => assert.fail('must stay offline'));
    const [resolved] = await provider.resolveIngredient('GENTAMICIN (AS SULFATE)', undefined, 'local');
    assert.equal(resolved.ddinterId, 'DDInter1'); assert.equal(resolved.mapping, 'verified_alias');
    assert.equal(resolved.original, 'GENTAMICIN (AS SULFATE)'); assert.equal(resolved.name, 'gentamicin');
    assert.equal(resolved.rxCui, '1596450'); assert.equal(resolved.normalization?.matchedName, 'gentamicin sulfate');
    assert.equal(resolved.normalization?.matchedRxCui, '1870193');
    assert.match(resolved.normalization?.lookupUrl || '', /GENTAMICIN%20SULFATE&search=0$/);
    assert.equal(resolved.normalization?.reused, true);
    assert.equal(db.prepare('SELECT * FROM ingredient_registry').all().length, 0);
    assert.equal(db.prepare('SELECT * FROM drug_api_cache').all().length, 0);
    assert.equal((await provider.labels([resolved], 'local')).status, 'not_requested');
  } finally { db.close(); }
});

test('Current source conflicts and a locally recorded review requirement are not overridden by shipped evidence', async () => {
  const db = openDrugDatabase(':memory:');
  try {
    const provider = new DrugProviders(db, async () => assert.fail('must stay offline'));
    const original = 'GENTAMICIN (AS SULFATE)';
    const csv = (id: string) => `DDInterID_A,Drug_A,DDInterID_B,Drug_B,Level\n${id},Gentamicin,DDInter2,Other,Unknown\n`;
    importDdinter(db, [{ name: 'synthetic.csv', csv: csv('DDInter1') }]);
    assert.equal((await provider.resolveIngredient(original, undefined, 'local'))[0].ddinterId, 'DDInter1');
    importDdinter(db, [{ name: 'synthetic.csv', csv: csv('DDInter3') }]);
    assert.equal((await provider.resolveIngredient(original, undefined, 'local'))[0].ddinterId, 'DDInter3');
    importDdinter(db, [{ name: 'synthetic.csv', csv: csv('DDInter3') + `DDInter4,${original},DDInter2,Other,Unknown\n` }]);
    const [conflict] = await provider.resolveIngredient(original, undefined, 'local');
    assert.equal(conflict.ddinterId, 'DDInter4'); assert.equal(conflict.rxCui, undefined);
    importDdinter(db, [{ name: 'synthetic.csv', csv: csv('DDInter3') }]);
    const { key } = ingredientLookup(original);
    writeIngredientRecord(db, key, { schema: 1, status: 'needs_review', checkedAt: '2026-09-28T00:00:00.000Z', version: 'test',
      lookupUrl: 'https://rxnav.nlm.nih.gov/REST/rxcui.json?name=GENTAMICIN%20SULFATE&search=0', reason: 'New source requires review' });
    const [blocked] = await provider.resolveIngredient(original, undefined, 'local');
    assert.equal(blocked.rxCui, undefined); assert.equal(blocked.ddinterId, undefined);
  } finally { db.close(); }
});

test('A differently named DDInter base needs the reviewed PIN and IN, and conflicting current names are refused', async () => {
  const db = openDrugDatabase(':memory:');
  try {
    const provider = new DrugProviders(db, async () => assert.fail('must stay offline'));
    const original = 'SALBUTAMOL (SULFATE)';
    const csv = 'DDInterID_A,Drug_A,DDInterID_B,Drug_B,Level\nDDInter1,Salbutamol,DDInter2,Other,Unknown\n';
    importDdinter(db, [{ name: 'synthetic.csv', csv }]);
    const [resolved] = await provider.resolveIngredient(original, undefined, 'local');
    assert.equal(resolved.ddinterId, 'DDInter1'); assert.equal(resolved.name, 'albuterol');
    assert.equal(resolved.normalization?.matchedName, 'albuterol sulfate');
    assert.equal(resolved.ddinterNormalization?.name, 'SALBUTAMOL');
    assert.match(resolved.ddinterNormalization?.lookupUrl || '', /name=SALBUTAMOL&search=0$/);
    const verified = verifiedIngredientName(original)!;
    const updated = structuredClone(verified.record!);
    updated.matched!.rxcui = '999999'; // A changed PIN cannot borrow the old base-name evidence.
    writeIngredientRecord(db, ingredientLookup(original).key, updated);
    assert.equal((await provider.resolveIngredient(original, undefined, 'local'))[0].ddinterId, undefined);
    db.prepare('DELETE FROM ingredient_registry').run();
    importDdinter(db, [{ name: 'synthetic.csv', csv: csv + 'DDInter3,Albuterol,DDInter2,Other,Unknown\n' }]);
    const [conflict] = await provider.resolveIngredient(original, undefined, 'local');
    assert.equal(conflict.ddinterId, undefined); assert.equal(conflict.rxCui, undefined);
  } finally { db.close(); }
});

test('Every shipped qualification has exact active PIN and IN evidence with a unique source relationship', async () => {
  const { reviewedQualifiedNames } = await import('../server/medications/reviewed-qualified-names');
  const source = JSON.parse(await readFile(new URL('../docs/sources/qualified-ingredients-20260927.json', import.meta.url), 'utf8'));
  const snapshots = new Map<string, any>();
  for (const item of source.snapshots) {
    assert.equal(createHash('sha256').update(item.raw).digest('hex'), item.sha256);
    assert.equal(new URL(item.url).origin, 'https://rxnav.nlm.nih.gov');
    assert.ok(Number.isFinite(Date.parse(item.retrievedAt)));
    snapshots.set(item.url, JSON.parse(item.raw));
  }
  const unique = new Set();
  assert.equal(reviewedQualifiedNames.length, 79);
  assert.equal(source.entries.length, reviewedQualifiedNames.length);
  for (const entry of reviewedQualifiedNames) {
    assert.ok(!unique.has(entry.original)); unique.add(entry.original);
    const record = entry.record, pin = record.matched!, base = record.ingredient!;
    const parts = /^([^()]+?)\s*\(\s*(?:AS\s+)?([^()]+)\s*\)$/.exec(entry.original)!;
    assert.ok(parts); assert.equal(entry.name, `${parts[1].trim()} ${parts[2].trim()}`);
    assert.equal(record.version, source.version.version);
    const canonical = new URL(record.lookupUrl);
    assert.equal(canonical.searchParams.get('search'), '0'); assert.equal(canonical.searchParams.get('name'), entry.name);
    assert.deepEqual(snapshots.get(record.lookupUrl).idGroup.rxnormId, [pin.rxcui]);
    const props = snapshots.get(`https://rxnav.nlm.nih.gov/REST/rxcui/${pin.rxcui}/properties.json`).properties;
    assert.equal(props.tty, 'PIN'); assert.equal(props.suppress, 'N'); assert.equal(props.name, pin.name);
    const baseLookup = source.entries.find(e => e.original === entry.original).baseLookupUrl;
    assert.equal(new URL(baseLookup).searchParams.get('name'), parts[1].trim());
    assert.deepEqual(snapshots.get(baseLookup).idGroup.rxnormId, [base.rxcui]);
    const baseProps = snapshots.get(`https://rxnav.nlm.nih.gov/REST/rxcui/${base.rxcui}/properties.json`).properties;
    assert.equal(baseProps.tty, 'IN'); assert.equal(baseProps.suppress, 'N'); assert.equal(baseProps.name, base.name);
    const groups = snapshots.get(`https://rxnav.nlm.nih.gov/REST/rxcui/${pin.rxcui}/related.json?tty=IN`).relatedGroup.conceptGroup;
    const ingredients = groups.filter(g => g.tty === 'IN').flatMap(g => g.conceptProperties || []);
    assert.equal(ingredients.length, 1); assert.equal(ingredients[0].rxcui, base.rxcui); assert.equal(ingredients[0].suppress, 'N');
  }
});
