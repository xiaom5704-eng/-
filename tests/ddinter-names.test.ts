import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DrugProviders, ingredientAliases, ingredientLookup } from '../server/medications/providers';
import { ingredientRegistryKey, writeIngredientRecord, type IngredientRecord } from '../server/medications/ingredient-registry';
import { openDrugDatabase, type DrugDatabase } from '../server/medications/store';
import { importDdinter, importTfda } from '../server/medications/importers';
import { reportToMarkdown } from '../shared/medication';

const record = (name: string, rxcui = '10', canonical = 'alpha'): IngredientRecord => ({
  schema: 1, status: 'matched', checkedAt: '2026-09-20T00:00:00.000Z', version: '08-Sep-2026',
  lookupUrl: `https://rxnav.nlm.nih.gov/REST/rxcui.json?name=${encodeURIComponent(name)}&search=0`,
  matched: { name: canonical, rxcui, tty: 'IN' }, ingredient: { name: canonical, rxcui, tty: 'IN' },
});
const store = (db: DrugDatabase, name: string, value = record(name), key = ingredientRegistryKey([name])) => writeIngredientRecord(db, key, value);
const seed = (db: DrugDatabase, id = 'DDInter1') => importDdinter(db, [{ name: 'synthetic.csv', csv: `DDInterID_A,Drug_A,DDInterID_B,Drug_B,Level\n${id},Alpha alias,DDInter2,Beta,Moderate\n` }]);
const offline = (db: DrugDatabase) => new DrugProviders(db, (async () => { assert.fail('Local lookup made an external request'); }) as typeof fetch);

test('Two exact IN lookups bridge different source names offline, retain provenance and use the current DDInter catalog', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'ddi-names-'));
  let db = openDrugDatabase(path.join(directory, 'test.db'));
  try {
    seed(db); store(db, 'alpha');
    assert.equal((await offline(db).resolveIngredient('alpha', undefined, 'local'))[0].ddinterId, undefined);
    store(db, 'Alpha alias');
    const bridged = (await offline(db).resolveIngredient('alpha', undefined, 'local'))[0];
    assert.equal(bridged.ddinterId, 'DDInter1');
    assert.equal(bridged.ddinterNormalization?.name, 'Alpha alias');
    assert.equal(bridged.ddinterNormalization?.checkedAt, '2026-09-20T00:00:00.000Z');
    db.close(); db = openDrugDatabase(path.join(directory, 'test.db'));
    seed(db, 'DDInter3');
    assert.equal((await offline(db).resolveIngredient('alpha', undefined, 'local'))[0].ddinterId, 'DDInter3');
    db.prepare("UPDATE ddinter_drugs SET name='Unrelated',normalized_name='unrelated' WHERE id='DDInter3'").run();
    assert.equal((await offline(db).resolveIngredient('alpha', undefined, 'local'))[0].ddinterId, undefined);
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('DDInter-side salts, products, suppression, mixed IDs, normalized searches and scoped aliases cannot become IN bridges', async () => {
  const changes: Array<{ edit?: (value: IngredientRecord) => void; key?: string }> = [
    { edit: r => { r.matched!.tty = 'PIN'; } },
    { edit: r => { (r.matched as any).tty = 'SBD'; } },
    { edit: r => { r.matched!.suppress = 'Y'; } },
    { edit: r => { r.ingredient!.suppress = 'Y'; } },
    { edit: r => { r.matched!.rxcui = '11'; } },
    { edit: r => { r.lookupUrl = r.lookupUrl.replace('search=0', 'search=2'); } },
    { edit: r => { r.lookupUrl += '&search=0'; } },
    { edit: r => { r.lookupUrl = r.lookupUrl.replace('Alpha%20alias', 'Other'); } },
    { key: ingredientRegistryKey(['Alpha alias'], 'https://example.org/product-specific') },
    { key: ingredientRegistryKey(['Other', 'Alpha alias']) },
  ];
  for (const change of changes) {
    const db = openDrugDatabase(':memory:');
    try {
      seed(db); store(db, 'alpha');
      const value = record('Alpha alias'); change.edit?.(value); store(db, 'Alpha alias', value, change.key);
      assert.equal((await offline(db).resolveIngredient('alpha', undefined, 'local'))[0].ddinterId, undefined);
    } finally { db.close(); }
  }
});

test('Ambiguous DDInter identities stay unknown and an exact existing identity is not replaced', async () => {
  const db = openDrugDatabase(':memory:');
  try {
    seed(db); store(db, 'alpha'); store(db, 'Alpha alias'); store(db, 'Second alias');
    db.prepare('INSERT INTO ddinter_drugs VALUES (?,?,?)').run('DDInter3', 'Second alias', 'second alias');
    assert.equal((await offline(db).resolveIngredient('alpha', undefined, 'local'))[0].ddinterId, undefined);
    assert.equal((await offline(db).resolveIngredient('Alpha alias', undefined, 'local'))[0].ddinterId, 'DDInter1');
    db.prepare("UPDATE ddinter_drugs SET name='Alpha alias',normalized_name='alpha alias' WHERE id='DDInter3'").run();
    assert.equal((await offline(db).resolveIngredient('alpha', undefined, 'local'))[0].ddinterId, undefined);
  } finally { db.close(); }
});

test('Existing interaction and saved report retain both sides of the bridge; malformed registry rows cannot break local lookup', async () => {
  const db = openDrugDatabase(':memory:');
  try {
    seed(db); store(db, 'alpha'); store(db, 'Alpha alias');
    db.prepare('INSERT INTO ingredient_registry VALUES(?,?)').run('invalid', '{broken');
    importTfda(db, [{ 許可證字號: 'TEST', 中文品名: 'Synthetic', 主成分略述: 'alpha;;Beta' }]);
    const drug = JSON.parse((db.prepare('SELECT payload FROM tfda_drugs').get() as { payload: string }).payload);
    const report = await offline(db).report([drug], 'local');
    assert.equal(report.interactions.length, 1);
    assert.equal(report.interactions[0].status, 'found'); assert.equal(report.interactions[0].level, 'Moderate');
    const md = reportToMarkdown(report);
    for (const text of ['Alpha alias', 'DDInter1', '相同 RxCUI 10', 'Alpha%20alias&search=0', 'rxcui/10/properties.json', '2026\\-09\\-20']) assert.ok(md.includes(text), text);
  } finally { db.close(); }
});

test('TFDA explicit equivalence tolerates whitespace and repeated EQ TO clauses without stripping other qualifiers', () => {
  const value = 'SODIUM BICARBONATE ( EQ TO SODIUM HYDROGEN CARBONATE)';
  assert.deepEqual(ingredientAliases(value), [value, 'SODIUM BICARBONATE', 'SODIUM HYDROGEN CARBONATE']);
  const chain = 'ALPHA (eq to BETA) ( EQ TO GAMMA )';
  assert.deepEqual(ingredientAliases(chain), [chain, 'ALPHA', 'BETA', 'GAMMA']);
  for (const name of ['ALPHA (SODIUM)', 'ALPHA (AS SULFATE)', 'ALPHA (topical)', 'ALPHA (EQ TO )', 'ALPHA (EQ TO BETA) + GAMMA', 'ALPHA (EQ TO BETA (OTHER))']) assert.deepEqual(ingredientAliases(name), [name]);
  assert.deepEqual(ingredientAliases('ALPHA SODIUM ( EQ TO BETA SODIUM)'), ['ALPHA SODIUM ( EQ TO BETA SODIUM)', 'ALPHA SODIUM', 'BETA SODIUM']);
});

test('Expanded equivalence parser preserves previously verified names and dates but does not recycle misses', async () => {
  const db = openDrugDatabase(':memory:');
  try {
    const original = 'ALPHA (EQ TO ALIAS A)(EQ TO ALIAS B)';
    const { key, previousKey } = ingredientLookup(original);
    assert.notEqual(key, previousKey);
    store(db, original, record('ALIAS B'), previousKey);
    assert.equal((await offline(db).resolveIngredient(original, undefined, 'local'))[0].normalization?.checkedAt, '2026-09-20T00:00:00.000Z');
    store(db, original, { ...record('ALIAS B'), status: 'not_found' }, previousKey);
    assert.equal((await offline(db).resolveIngredient(original, undefined, 'local'))[0].rxCui, undefined);
    store(db, original, record('UNRELATED'), previousKey);
    assert.equal((await offline(db).resolveIngredient(original, undefined, 'local'))[0].rxCui, undefined);
  } finally { db.close(); }
});

test('An explicit alias can resolve earlier ambiguity only when its unique exact concept agrees with every candidate set', async () => {
  for (const prior of [[['10', '20']], [['10', '20'], ['10', '30']], [['10', '20'], ['20', '30']]]) {
    const db = openDrugDatabase(':memory:');
    try {
      const provider = new DrugProviders(db, (async (url: URL) => {
        const json = (data: unknown) => new Response(JSON.stringify(data));
        if (url.pathname.endsWith('/version.json')) return json({ version: '08-Sep-2026' });
        if (url.pathname.endsWith('/properties.json')) return json({ properties: record('unique').matched });
        if (url.pathname.endsWith('/related.json')) return json({ relatedGroup: { conceptGroup: [{ tty: 'IN', conceptProperties: [record('unique').ingredient] }] } });
        assert.equal(url.searchParams.get('search'), '0');
        const name = url.searchParams.get('name');
        const rxnormId = name === 'ALPHA' ? prior[0] : name === 'AMBIGUOUS' ? prior[1] ?? [] : name === 'UNIQUE' ? ['10'] : [];
        return json({ idGroup: { rxnormId } });
      }) as unknown as typeof fetch);
      const original = 'ALPHA (EQ TO AMBIGUOUS) ( EQ TO UNIQUE)';
      const result = (await provider.resolveIngredient(original))[0];
      const agrees = prior.every(ids => ids.includes('10'));
      assert.equal(result.rxCui, agrees ? '10' : undefined);
      if (agrees) assert.ok(result.normalization?.lookupUrl.includes('name=UNIQUE&search=0'));
      assert.equal((await offline(db).resolveIngredient(original, undefined, 'local'))[0].rxCui, result.rxCui);
    } finally { db.close(); }
  }
});
