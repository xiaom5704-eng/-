import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifiedIngredientName } from '../server/medications/verified-names';
import { DrugProviders } from '../server/medications/providers';
import { importDdinter, importTfda } from '../server/medications/importers';
import { getTfda, openDrugDatabase } from '../server/medications/store';
import { reportToMarkdown } from '../shared/medication';

test('Reviewed complete synonym annotations resolve while distinct forms remain separate', () => {
  assert.equal(verifiedIngredientName('NIACINAMIDE (NICOTINAMIDE)')?.name, 'nicotinamide');
  assert.equal(verifiedIngredientName(' cyanocobalamin  (vit b12) ')?.name, 'cyanocobalamin');
  assert.equal(verifiedIngredientName('NIACIN (NICOTINIC ACID)')?.name, 'niacin');
  for (const original of ['NIACIN (NIACINAMIDE)', 'NICOTINAMIDE (HCL)', 'CYANOCOBALAMIN (0.1%)',
    'CYANOCOBALAMIN (ANHYDROUS)', 'VITAMIN B12', 'METHYLCOBALAMIN (VIT B12)', 'HYDROXOCOBALAMIN (VIT B12)',
    'NIACINAMIDE (NICOTINAMIDE) 100 MG', 'UNKNOWN (VIT B12)']) assert.equal(verifiedIngredientName(original), undefined, original);
});

// Synthetic products and pairs test lookup behavior, not clinical evidence.
test('Offline reports recover existing pairs and duplicates without fabricating RxNorm or label matches', async () => {
  const db = openDrugDatabase(':memory:');
  try {
    importTfda(db, [
      { 許可證字號: 'TEST-A', 中文品名: 'Synthetic combination', 英文品名: 'Test A', 主成分略述: 'NIACINAMIDE (NICOTINAMIDE);;CYANOCOBALAMIN (VIT B12);;NIACIN (NICOTINIC ACID)', 註銷狀態: '' },
      { 許可證字號: 'TEST-B', 中文品名: 'Synthetic comparison', 英文品名: 'Test B', 主成分略述: 'NIACIN;;NICOTINAMIDE;;CYANOCOBALAMIN', 註銷狀態: '' },
    ]);
    importDdinter(db, [{ name: 'synthetic.csv', csv: 'DDInterID_A,Drug_A,DDInterID_B,Drug_B,Level\nDDInter1,Nicotinamide,DDInter2,Cyanocobalamin,Unknown\nDDInter2,Cyanocobalamin,DDInter3,Niacin,Moderate\n' }]);
    let requests = 0;
    const providers = new DrugProviders(db, async () => { requests++; throw Error('Network forbidden'); });
    const report = await providers.report([getTfda(db, 'TEST-A')!, getTfda(db, 'TEST-B')!], 'local');
    assert.equal(requests, 0);
    assert.equal(report.interactions.filter(pair => pair.status === 'duplicate').length, 3);
    assert.equal(report.interactions.filter(pair => pair.status === 'found').length, 8);
    assert.equal(report.interactions.filter(pair => pair.status === 'not_found').length, 4);
    assert.ok(report.interactions.some(pair => pair.level === 'Unknown'));
    assert.deepEqual(report.medications[0].ingredients.map(i => i.original), ['NIACINAMIDE (NICOTINAMIDE)', 'CYANOCOBALAMIN (VIT B12)', 'NIACIN (NICOTINIC ACID)']);
    for (const entry of report.medications[0].ingredients) {
      assert.equal(entry.mapping, 'verified_alias');
      assert.ok(entry.aliasSourceUrl?.startsWith('https://rxnav.nlm.nih.gov/'));
      assert.equal(entry.rxCui, undefined);
    }
    assert.equal(report.medications[0].labelStatus, 'not_requested');
    assert.deepEqual(report.medications[0].labels, []);
    const saved = reportToMarkdown(report);
    assert.ok(saved.includes('NIACINAMIDE \\(NICOTINAMIDE\\) → nicotinamide'));
    for (const entry of report.medications[0].ingredients) assert.ok(saved.includes(entry.aliasSourceUrl!));
  } finally { db.close(); }
});

test('Verified aliases follow current DDInter IDs and cannot override conflicting source names', async () => {
  const db = openDrugDatabase(':memory:');
  try {
    const providers = new DrugProviders(db, async () => { throw Error('Network forbidden'); });
    const resolve = () => providers.resolveIngredient('NIACINAMIDE (NICOTINAMIDE)', undefined, 'local');
    assert.equal((await resolve())[0].ddinterId, undefined);
    const csv = (id: string) => `DDInterID_A,Drug_A,DDInterID_B,Drug_B,Level\n${id},Nicotinamide,DDInter2,Other,Unknown\n`;
    importDdinter(db, [{ name: 'synthetic.csv', csv: csv('DDInter1') }]);
    assert.equal((await resolve())[0].ddinterId, 'DDInter1');
    importDdinter(db, [{ name: 'synthetic.csv', csv: csv('DDInter3') }]);
    assert.equal((await resolve())[0].ddinterId, 'DDInter3');
    importDdinter(db, [{ name: 'synthetic.csv', csv: csv('DDInter3') + 'DDInter4,NIACINAMIDE (NICOTINAMIDE),DDInter2,Other,Unknown\n' }]);
    assert.equal((await resolve())[0].ddinterId, undefined);
    assert.equal((await resolve())[0].mapping, 'unmapped');
  } finally { db.close(); }
});
