import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DrugProviders } from '../server/medications/providers';
import { openDrugDatabase, type DrugDatabase } from '../server/medications/store';
import { importDdinter, importTfda } from '../server/medications/importers';
import { reportToMarkdown } from '../shared/medication';
import { safetySources } from '../shared/medication-safety';

const opened: DrugDatabase[] = [];
const database = (filename = ':memory:') => { const db = openDrugDatabase(filename); opened.push(db); return db; };
afterEach(() => opened.splice(0).forEach(db => { if (db.open) db.close(); }));
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const concept = { rxcui: '20', name: 'alpha sodium', tty: 'PIN', suppress: 'N' };
const ingredient = { rxcui: '10', name: 'alpha', tty: 'IN', suppress: 'N' };
function fixture(options: { matched?: unknown; ingredients?: unknown[]; ids?: string[] } = {}) {
  return (async (input: URL) => {
    if (input.pathname.endsWith('/version.json')) return json({ version: '08-Sep-2026' });
    if (input.pathname.endsWith('/properties.json')) return json({ properties: options.matched ?? concept });
    if (input.pathname.endsWith('/related.json')) return json({ relatedGroup: { conceptGroup: [{ tty: 'IN', conceptProperties: options.ingredients ?? [ingredient] }] } });
    assert.equal(input.searchParams.get('search'), '0');
    return json({ idGroup: { rxnormId: options.ids ?? ['20'] } });
  }) as unknown as typeof fetch;
}
function seedDdi(db: DrugDatabase, id = 'DDInter1') {
  importDdinter(db, [{ name: 'synthetic.csv', csv: `DDInterID_A,Drug_A,DDInterID_B,Drug_B,Level\n${id},Alpha,DDInter2,Beta,Moderate\n` }]);
}
function ageRegistry(db: DrugDatabase) {
  db.prepare("UPDATE ingredient_registry SET payload=json_set(payload, '$.checkedAt', '2020-01-01T00:00:00.000Z')").run();
  db.prepare('DELETE FROM drug_api_cache').run();
}

test('Exact salt relationship survives database reopen, works offline and follows current DDInter IDs', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'medication-registry-'));
  const filename = path.join(directory, 'test.db');
  try {
    let db = database(filename); seedDdi(db);
    const online = (await new DrugProviders(db, fixture()).resolveIngredient('Alpha sodium'))[0];
    assert.equal(online.rxCui, '10'); assert.equal(online.ddinterId, 'DDInter1');
    assert.equal(online.normalization?.matchedRxCui, '20');
    assert.equal(online.normalization?.reused, false);
    db.close(); db = database(filename); seedDdi(db, 'DDInter3');
    let requests = 0;
    const offline = new DrugProviders(db, (async () => { requests++; throw new Error('No network'); }) as typeof fetch);
    const stored = (await offline.resolveIngredient('Alpha sodium', undefined, 'local'))[0];
    assert.equal(stored.rxCui, '10'); assert.equal(stored.ddinterId, 'DDInter3');
    assert.equal(stored.normalization?.version, '08-Sep-2026');
    assert.equal(stored.normalization?.reused, true); assert.equal(requests, 0);
    db.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('Stored product-scoped aliases never leak into another product or a free ingredient search', async () => {
  const db = database();
  const provider = new DrugProviders(db, (async (url: URL, init) => {
    if (url.pathname.endsWith('/rxcui.json') && url.searchParams.get('name') === 'ACETAMINOPHEN FINE') return json({ idGroup: {} });
    return fixture()(url, init);
  }) as unknown as typeof fetch);
  const product = { source: 'tfda' as const, id: '衛署藥輸字第023784號' };
  assert.ok((await provider.resolveIngredient('ACETAMINOPHEN FINE', product))[0].rxCui);
  assert.ok((await provider.resolveIngredient('ACETAMINOPHEN FINE', product, 'local'))[0].rxCui);
  assert.equal((await provider.resolveIngredient('ACETAMINOPHEN FINE', { ...product, id: 'OTHER' }, 'local'))[0].rxCui, undefined);
  assert.equal((await provider.resolveIngredient('ACETAMINOPHEN FINE', undefined, 'local'))[0].rxCui, undefined);
});

test('K.B.T. label names recover local Kaolin without substituting other bismuth salts or Scopolia extract', async () => {
  const db = database(); let requests = 0;
  importDdinter(db, [{ name: 'synthetic.csv', csv: 'DDInterID_A,Drug_A,DDInterID_B,Drug_B,Level\nDDInter1005,Kaolin,DDInter1,Bismuth subsalicylate,Moderate\nDDInter1647,Scopolamine,DDInter2,Beta,Minor\n' }]);
  const provider = new DrugProviders(db, (async () => { requests++; throw new Error('No network'); }) as typeof fetch);
  const product = { source: 'tfda' as const, id: '內衛藥製字第007592號' };
  const original = 'KAOLIN (WHITE)(BOLUS ALBA)';
  const kaolin = (await provider.resolveIngredient(original, product, 'local'))[0];
  assert.equal(kaolin.original, original);
  assert.equal(kaolin.name, 'kaolin');
  assert.equal(kaolin.ddinterId, 'DDInter1005');
  assert.equal(kaolin.mapping, 'verified_alias');
  assert.equal(kaolin.aliasSourceUrl, safetySources.kbt.url);
  const albumin = (await provider.resolveIngredient('ALBUMIN TANNATE (TANNALBIN)', product, 'local'))[0];
  assert.equal(albumin.name, 'albumin tannate');
  assert.equal(albumin.ddinterId, undefined);
  for (const selection of [undefined, { ...product, id: 'OTHER' }, { source: 'rxnorm' as const, id: product.id }]) {
    assert.equal((await provider.resolveIngredient(original, selection, 'local'))[0].ddinterId, undefined);
  }
  for (const ingredient of ['BISMUTH SUBCARBONATE', 'SCOPOLIA EXTRACT', 'KAOLIN (OTHER)']) {
    assert.equal((await provider.resolveIngredient(ingredient, product, 'local'))[0].ddinterId, undefined);
  }
  assert.equal(requests, 0);
});

test('A failed refresh preserves dated evidence; a completed no-match refresh invalidates it', async () => {
  const db = database(); seedDdi(db);
  await new DrugProviders(db, fixture()).resolveIngredient('Alpha sodium');
  ageRegistry(db);
  const broken = new DrugProviders(db, (async () => json({}, 503)) as typeof fetch);
  assert.equal((await broken.resolveIngredient('Alpha sodium'))[0].rxCui, '10');
  assert.equal((await broken.resolveIngredient('Alpha sodium'))[0].normalization?.checkedAt, '2020-01-01T00:00:00.000Z');
  const refreshed = new DrugProviders(db, fixture({ ids: [] }));
  assert.equal((await refreshed.resolveIngredient('Alpha sodium'))[0].rxCui, undefined);
  assert.equal((await refreshed.resolveIngredient('Alpha sodium', undefined, 'local'))[0].rxCui, undefined);
});

test('Brands, combination concepts, suppressed concepts and multiple ingredients remain unresolved', async () => {
  for (const options of [
    { matched: { ...concept, tty: 'SBD' } }, { matched: { ...concept, tty: 'MIN' } },
    { matched: { ...concept, suppress: 'Y' } },
    { ingredients: [ingredient, { ...ingredient, rxcui: '11', name: 'beta' }] },
    { ingredients: [{ ...ingredient, tty: 'PIN' }] },
    { matched: { ...concept, tty: 'IN' } }, // An IN must resolve to itself, not a different IN.
    { ids: ['20', '21'] },
  ]) {
    const db = database();
    const provider = new DrugProviders(db, fixture(options));
    assert.equal((await provider.resolveIngredient('Alpha sodium'))[0].rxCui, undefined);
    assert.equal((await provider.resolveIngredient('Alpha sodium', undefined, 'local'))[0].rxCui, undefined);
  }
});

test('A conflicting direct DDInter identity cannot be overridden by RxNorm', async () => {
  const db = database();
  importDdinter(db, [{ name: 'synthetic.csv', csv: 'DDInterID_A,Drug_A,DDInterID_B,Drug_B,Level\nDDInter1,Alpha sodium,DDInter2,Alpha,Minor\n' }]);
  const provider = new DrugProviders(db, fixture());
  const result = (await provider.resolveIngredient('Alpha sodium'))[0];
  assert.equal(result.ddinterId, 'DDInter1'); assert.equal(result.rxCui, undefined);
  assert.equal((await provider.resolveIngredient('Alpha sodium', undefined, 'local'))[0].rxCui, undefined);
});

test('Saved offline reports retain lookup, relationship, version, age of evidence and distinct unknown DDInter state', async () => {
  const db = database();
  importTfda(db, [{ 許可證字號: 'TEST', 中文品名: 'Synthetic', 英文品名: 'Synthetic', 主成分略述: 'Alpha sodium', 註銷狀態: '' }]);
  const provider = new DrugProviders(db, fixture());
  await provider.resolveIngredient('Alpha sodium'); ageRegistry(db);
  const drug = JSON.parse((db.prepare('SELECT payload FROM tfda_drugs').get() as { payload: string }).payload);
  const report = await provider.report([drug], 'local');
  const resolved = report.medications[0].ingredients[0];
  assert.equal(resolved.rxCui, '10'); assert.equal(resolved.ddinterId, undefined);
  assert.equal(report.medications[0].labelStatus, 'not_requested');
  assert.ok(report.medications[0].warnings.some(text => text.includes('超過 30 天')));
  const markdown = reportToMarkdown(report);
  for (const content of ['08\\-Sep\\-2026', '2020\\-01\\-01', '重用本機紀錄', 'related.json?tty=IN', 'search=0']) assert.ok(markdown.includes(content), content);
});
