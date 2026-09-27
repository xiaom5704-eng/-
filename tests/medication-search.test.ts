import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { listenForFetch } from './http-listener';
import express from 'express';
import { getTfda, normalizeName, openDrugDatabase, searchLocalCandidates } from '../server/medications/store';
import { importTfda } from '../server/medications/importers';
import { importAppearance, matchObservation } from '../server/medications/appearance';
import { initializeSearchIndex, parsePageOptions, searchKey, searchRevision, SearchSnapshotChanged } from '../server/medications/search-index';
import { medicationRouter } from '../server/medications/router';
import { DrugProviders } from '../server/medications/providers';
import { splitSearchMeasurements } from '../server/medications/search-measurements';

const row = (id: string, name = '測試錠', english = 'ALPHA TABLETS', ingredient = 'Alpha') => ({ 許可證字號: id, 中文品名: name, 英文品名: english, 主成分略述: ingredient, 申請商名稱: 'Synthetic factory', 劑型: '錠劑', 註銷狀態: '' });
const database = (t: TestContext) => { const db = openDrugDatabase(':memory:'); t.after(() => db.close()); return db; };
const appearanceCsv = (ids: string[], color = '白') => Buffer.from([
  '許可證字號,中文品名,英文品名,形狀,特殊劑型,顏色,特殊氣味,刻痕,外觀尺寸,標註一,標註二,外觀圖檔連結',
  ...ids.map(id => `${id},測試外觀舊名,ALPHA TABLETS,圓形,,${color},,,8,AB/25,,`),
].join('\n'));

test('Local candidate search accepts separated keywords, punctuation and fullwidth text without altering returned identity', t => {
  const db = database(t);
  importTfda(db, [row('TEST001', '「測試」甲錠', 'K.B.T. TABLETS 1.5MG', 'Alpha sodium'), row('TEST002', '測試乙錠', 'K.B.T. TABLETS 15MG', 'Beta')]);
  for (const query of ['KBT', 'Ｋ．Ｂ．Ｔ', '測試 錠', 'kbt factory']) assert.equal(searchLocalCandidates(db, query).total, 2, query);
  for (const query of ['alpha sodium 1.5', '錠 甲', 'KBT 1.5MG']) assert.deepEqual(searchLocalCandidates(db, query).candidates.map(d => d.id), ['TEST001'], query);
  assert.equal(searchLocalCandidates(db, 'alpha unknown').total, 0);
  assert.equal(searchLocalCandidates(db, '...').total, 0);
  assert.notEqual(searchKey('1.5'), searchKey('15'));
  assert.notEqual(searchKey('1,000'), searchKey('1.000'));
  assert.deepEqual(getTfda(db, 'TEST001')!.ingredients, ['Alpha sodium']);
});

test('Written strengths bind their number to the unit and accept attached names without matching license digits', t => {
  const db = database(t);
  importTfda(db, [row('LIC001', '人工甲錠5毫克', 'ALPHA TABLETS 5 MG'), row('LIC002', '人工甲錠1毫克', 'ALPHA TABLETS 1MG'),
    row('LIC003', '人工甲錠11毫克', 'ALPHA TABLETS 11MG'), row('LIC004', '人工甲錠0.1毫克', 'ALPHA TABLETS 0.1MG'),
    row('LIC005', '人工甲錠1.5毫克', 'ALPHA TABLETS 1.5MG'), row('LIC006', '人工甲錠15毫克', 'ALPHA TABLETS 15MG'),
    row('LIC007', '人工甲錠', 'ALPHA TABLETS')]);
  for (const query of ['alpha1mg', 'alpha 1 mg', '人工甲1毫克', '人工甲 1 公絲', 'alpha 01.00 MG']) {
    assert.deepEqual(searchLocalCandidates(db, query).candidates.map(d => d.id), ['LIC002'], query);
  }
  assert.deepEqual(searchLocalCandidates(db, 'alpha1.5mg').candidates.map(d => d.id), ['LIC005']);
  assert.deepEqual(searchLocalCandidates(db, 'alpha.1mg').candidates.map(d => d.id), ['LIC004']);
  assert.equal(searchLocalCandidates(db, 'alpha 1000 mcg').total, 0, 'no conversion between magnitudes and units');
  assert.equal(searchLocalCandidates(db, 'alpha').total, 7, 'name-only lookup still includes products with missing strengths');
  assert.equal(matchObservation(db, { name: 'alpha', strength: '1 mg', dosageForm: '' }).candidates[0].id, 'LIC002');
});

test('Concentrations retain denominators and do not match standalone strengths or a different volume', t => {
  const db = database(t);
  importTfda(db, [row('A', '人工乙液0.4毫克/毫升', 'BETA 0.4 MG/ML'), row('B', '人工乙液0.4毫克/5毫升', 'BETA 0.4 MG/5 ML'),
    row('C', '人工乙錠0.4毫克', 'BETA 0.4MG'), row('D', '人工乙液4毫克/毫升', 'BETA 4MG/ML')]);
  for (const query of ['beta0.4mg/ml', 'beta 0.4 mg / 1 ml', '人工乙0.4毫克/毫升']) {
    assert.deepEqual(searchLocalCandidates(db, query).candidates.map(d => d.id), ['A'], query);
  }
  assert.deepEqual(searchLocalCandidates(db, 'beta 0.4 mg/5 ml').candidates.map(d => d.id), ['B']);
  assert.deepEqual(searchLocalCandidates(db, 'beta 0.4 mg').candidates.map(d => d.id), ['C']);
  assert.equal(searchLocalCandidates(db, 'beta 0.08 mg/ml').total, 0);
  importTfda(db, [row('E', '人工乙乳膏0.5%', 'BETA CREAM 0.5%'), row('F', '人工乙乳膏5%', 'BETA CREAM 5%')]);
  assert.deepEqual(searchLocalCandidates(db, 'beta .50%').candidates.map(d => d.id), ['E']);
});

test('Measurement parsing preserves complete ranges, fractions and literal ratios without arithmetic conversion', t => {
  assert.deepEqual(splitSearchMeasurements('人工藥5 mg / 5 mL').measurements, ['5mg/5ml']);
  assert.deepEqual(splitSearchMeasurements('人工藥 ５００ μg').measurements, ['500mcg']);
  assert.deepEqual(splitSearchMeasurements('人工藥0.50%').measurements, ['0.5%']);
  for (const input of ['1,000mg', '1/2 mg', '1-5mg', '1–5mg', '−5mg', '1e3mg', '10mg/kg/day', '1mg/5ml/day']) {
    assert.deepEqual(splitSearchMeasurements(input).measurements, [input.replace(/\s/g, '')]);
  }
  for (const input of ['5mgfoo', 'B12']) {
    assert.equal(splitSearchMeasurements(input).measurements.length, 0, input);
    assert.equal(splitSearchMeasurements(input).text, input.normalize('NFKC').toLowerCase(), input);
  }
  const db = database(t);
  importTfda(db, [row('RANGE', '人工規格1-5mg', 'OMEGA 1-5MG'), row('DECIMAL', '人工規格15mg', 'OMEGA 15MG'),
    row('FRACTION', '人工規格1/2mg', 'OMEGA 1/2MG'), row('TWO', '人工規格2mg', 'OMEGA 2MG'),
    row('GROUPED', '人工規格1,000mg', 'OMEGA 1,000MG'), row('ONE', '人工規格1.000mg', 'OMEGA 1.000MG')]);
  for (const [query, expected] of [['omega 1-5 mg', 'RANGE'], ['omega 1/2 mg', 'FRACTION'], ['omega 1,000 mg', 'GROUPED'], ['omega 1mg', 'ONE']]) {
    assert.deepEqual(searchLocalCandidates(db, query).candidates.map(d => d.id), [expected]);
  }
});

test('Measurements use current source names, exclude manufacturers and preserve appearance constraints', t => {
  const db = database(t);
  importTfda(db, [{ ...row('TFDA001', '人工丙錠5mg', 'GAMMA 5MG'), 申請商名稱: '1mg factory' }, row('TFDA002', '人工丙錠1mg', 'GAMMA 1MG')]);
  importAppearance(db, Buffer.from(appearanceCsv(['TFDA001', 'TFDA002', 'VISUAL001']).toString().replaceAll('ALPHA TABLETS', 'GAMMA 1MG')), 'synthetic.csv');
  const result = searchLocalCandidates(db, 'gamma 1mg');
  assert.deepEqual(new Set(result.candidates.map(d => d.id)), new Set(['TFDA002', 'VISUAL001']));
  assert.ok(result.candidates.find(d => d.id === 'VISUAL001')?.appearanceOnly);
  const appearance = { shape: '圓形', color: '紅', imprints: ['AB/25'] };
  assert.equal(searchLocalCandidates(db, 'gamma 1mg', appearance).total, 0);
  assert.equal(searchLocalCandidates(db, 'gamma 1mg', { ...appearance, color: '白', imprints: ['AB'] }).total, 0);
});

test('Measurement index migration is transactional and strength pages retain all results', t => {
  const db = database(t);
  importTfda(db, Array.from({ length: 27 }, (_, i) => row(`S${i}`, '人工規格錠1mg', 'STRENGTH 1MG')));
  const source = db.prepare('SELECT * FROM tfda_drugs ORDER BY id').all(), revision = searchRevision(db);
  db.exec('ALTER TABLE drug_search DROP COLUMN measurement_key; UPDATE drug_search_meta SET version=2;');
  const originalPayload = (db.prepare('SELECT payload FROM tfda_drugs WHERE id=?').get('S0') as { payload: string }).payload;
  db.prepare('UPDATE tfda_drugs SET payload=? WHERE id=?').run('{broken', 'S0');
  assert.throws(() => initializeSearchIndex(db));
  assert.equal(searchRevision(db), revision, 'a failed rebuild must not advance the snapshot');
  assert.ok(!(db.pragma('table_info(drug_search)') as { name: string }[]).some(column => column.name === 'measurement_key'), 'the schema change also rolls back');
  db.prepare('UPDATE tfda_drugs SET payload=? WHERE id=?').run(originalPayload, 'S0');
  initializeSearchIndex(db);
  assert.deepEqual(db.prepare('SELECT * FROM tfda_drugs ORDER BY id').all(), source);
  assert.throws(() => searchLocalCandidates(db, 'strength1mg', undefined, { offset: 20, revision }), SearchSnapshotChanged);
  const first = searchLocalCandidates(db, 'strength1mg');
  const second = searchLocalCandidates(db, 'strength 1 mg', undefined, { offset: 20, revision: first.page.revision });
  assert.equal(first.total, 27); assert.equal(second.candidates.length, 7);
  assert.equal(new Set([...first.candidates, ...second.candidates].map(d => d.id)).size, 27);
  const readyRevision = searchRevision(db); initializeSearchIndex(db); assert.equal(searchRevision(db), readyRevision);
});

test('Manual search and scanned strength use the same local specification constraints over HTTP', async t => {
  const db = database(t); let calls = 0;
  importTfda(db, [row('LIC001', '人工一錠5mg', 'OMEGA 5MG'), row('LIC002', '人工一錠1mg', 'OMEGA 1MG')]);
  const providers = new DrugProviders(db, (async () => { calls++; throw new Error('Must remain local'); }) as typeof fetch);
  const app = express(); app.use(express.json()); app.use('/meds', medicationRouter(db, providers));
  const server = await listenForFetch(app);
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/meds`;
  try {
    const manual = await (await fetch(`${base}/search?${new URLSearchParams({ q: 'omega 1 mg' })}`)).json();
    assert.deepEqual(manual.candidates.map((d: { id: string }) => d.id), ['LIC002']);
    assert.match(manual.warnings.join(''), /品名中的規格/);
    const scanned = await (await fetch(`${base}/match`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ observations: [{ name: 'omega', strength: '1mg', dosageForm: '' }] }) })).json();
    assert.deepEqual(scanned.matches[0].candidates.map((d: { id: string }) => d.id), ['LIC002']);
    assert.equal(calls, 0);
  } finally { server.close(); await once(server, 'close'); }
});

test('Exact licenses rank first, complete pages are stable and a shared appearance does not duplicate results', t => {
  const db = database(t);
  const rows = Array.from({ length: 55 }, (_, index) => row(`TEST${String(index).padStart(3, '0')}`, `測試錠${String(index).padStart(3, '0')}`));
  importTfda(db, [...rows, row('OTHER', 'TEST001', 'unrelated')]);
  importAppearance(db, appearanceCsv(['TEST001', 'VISUAL_ONLY']), 'synthetic.csv');
  assert.equal(searchLocalCandidates(db, 'TEST001').candidates[0].id, 'TEST001');
  const first = searchLocalCandidates(db, 'alpha');
  assert.equal(first.total, 57); assert.equal(first.candidates.length, 20);
  const all = [...first.candidates];
  for (let offset = 20; offset < first.total; offset += 20) {
    const next = searchLocalCandidates(db, 'alpha', undefined, { offset, revision: first.page.revision });
    assert.equal(next.total, first.total); assert.equal(next.page.hasMore, offset + 20 < first.total);
    all.push(...next.candidates);
  }
  assert.equal(new Set(all.map(d => d.id)).size, first.total);
  assert.ok(all.find(d => d.id === 'VISUAL_ONLY')?.appearanceOnly);
  assert.equal(searchLocalCandidates(db, '測試外觀舊名').candidates.find(d => d.id === 'TEST001')!.name, '測試錠001');
  assert.deepEqual(searchLocalCandidates(db, 'alpha').candidates, first.candidates);
});

test('Mixed OCR script finds original names without guessing digits, ingredients, imprints or a unique identity', t => {
  const db = database(t);
  importTfda(db, [row('TEST001', '人工普拿疼伏冒加強錠 1.5 mg'), row('TEST002', '人工普拿疼伏冒加強錠 15 mg'),
    row('TEST003', '人工測試後錠'), row('TEST004', '人工測試后錠')]);
  const before = getTfda(db, 'TEST001');
  for (const name of ['加強锭', '加强錠', '普拿疼 伏冒 加强锭']) {
    assert.equal(searchLocalCandidates(db, name).total, 2, name);
    assert.equal(matchObservation(db, { name, strength: '', dosageForm: '' }).total, 2, name);
  }
  assert.equal(searchLocalCandidates(db, '人工普拿疼 1.5 mg').candidates[0].id, 'TEST001');
  assert.equal(searchLocalCandidates(db, '人工普拿疼 I.5 mg').total, 0);
  assert.equal(searchLocalCandidates(db, '人工測試后錠').total, 2, 'script-equivalent names must remain separate candidate products');
  assert.deepEqual(getTfda(db, 'TEST001'), before);
  assert.notEqual(normalizeName('藥品'), normalizeName('药品'), 'identity normalization is unchanged');
  importAppearance(db, Buffer.from(appearanceCsv(['TEST001']).toString().replace('AB/25', '藥')), 'synthetic.csv');
  const observation = { name: '', strength: '', dosageForm: '', appearance: { shape: '', color: '', imprints: ['药'] } };
  assert.equal(matchObservation(db, observation).total, 0, 'pill imprints cannot inherit the broad script lookup');
  assert.equal(matchObservation(db, { ...observation, appearance: { ...observation.appearance, imprints: ['藥'] } }).total, 1);
});

test('Version-one search keys are rebuilt and invalidate older pages without editing source data', t => {
  const db = database(t);
  importTfda(db, [row('TEST001', '人工加強錠')]);
  const before = getTfda(db, 'TEST001'), revision = searchRevision(db);
  db.exec("UPDATE drug_search_meta SET version=1; UPDATE drug_search SET search_key='人工加強錠';");
  initializeSearchIndex(db);
  assert.equal(searchLocalCandidates(db, '加強锭').total, 1);
  assert.deepEqual(getTfda(db, 'TEST001'), before);
  assert.notEqual(searchRevision(db), revision);
  assert.throws(() => searchLocalCandidates(db, '加強锭', undefined, { revision, offset: 20 }), SearchSnapshotChanged);
});

test('Appearance pages preserve every original constraint and do not loosen full imprints', t => {
  const db = database(t);
  importAppearance(db, appearanceCsv(Array.from({ length: 25 }, (_, i) => `TEST${i}`)), 'synthetic.csv');
  const observation = { name: '', strength: '', dosageForm: '', appearance: { color: '白色', shape: '圓形', imprints: ['AB/25'] } };
  const first = matchObservation(db, observation);
  const last = matchObservation(db, observation, { offset: 20, revision: first.page.revision });
  assert.equal(last.candidates.length, 5); assert.equal(last.total, 25); assert.equal(last.page.hasMore, false);
  assert.equal(new Set([...first.candidates, ...last.candidates].map(d => d.id)).size, 25);
  assert.equal(matchObservation(db, { ...observation, appearance: { ...observation.appearance, color: '紅' } }).total, 0);
  assert.equal(matchObservation(db, { ...observation, appearance: { ...observation.appearance, imprints: ['AB'] } }).total, 0);
});

test('Legacy source records are indexed transactionally without replacing originals; imports invalidate old page snapshots', t => {
  const db = database(t);
  importTfda(db, [row('TEST001', '舊藥')]);
  importAppearance(db, appearanceCsv(['TEST001', 'VISUAL_ONLY']), 'synthetic.csv');
  const before = getTfda(db, 'TEST001');
  db.exec('DROP TABLE drug_search; DROP TABLE drug_search_meta;');
  initializeSearchIndex(db);
  assert.deepEqual(getTfda(db, 'TEST001'), before);
  assert.equal(searchLocalCandidates(db, 'alpha').total, 2);
  const version = searchRevision(db);
  initializeSearchIndex(db); assert.equal(searchRevision(db), version);
  assert.throws(() => importTfda(db, [{ missing: 'fields' }]));
  assert.equal(searchRevision(db), version);
  importTfda(db, [row('TEST002', '新藥')]);
  assert.equal(searchLocalCandidates(db, '舊藥').total, 0);
  assert.equal(searchLocalCandidates(db, '新藥').total, 1);
  assert.throws(() => searchLocalCandidates(db, 'alpha', undefined, { offset: 20, revision: version }), SearchSnapshotChanged);
});

test('Pagination rejects malformed offsets and revisions', () => {
  for (const offset of [-1, 1.2, NaN, Infinity, '1e2', '0 OR 1=1', ['0'], {}, 1_000_001]) assert.equal(parsePageOptions(offset, undefined), undefined);
  for (const revision of [[], {}, 2, '', '1;DROP TABLE']) assert.equal(parsePageOptions(0, revision), undefined);
  assert.deepEqual(parsePageOptions('20', '3'), { offset: 20, revision: '3' });
});

test('Search and appearance APIs expose complete local pagination, detect refreshes and never contact online providers', async t => {
  const db = database(t);
  importTfda(db, Array.from({ length: 25 }, (_, i) => row(`TEST${i}`)));
  importAppearance(db, appearanceCsv(Array.from({ length: 25 }, (_, i) => `TEST${i}`)), 'synthetic.csv');
  let requests = 0;
  const providers = new DrugProviders(db, (async () => { requests++; throw new Error('Must stay local'); }) as typeof fetch);
  const app = express(); app.use(express.json()); app.use('/meds', medicationRouter(db, providers));
  const server = await listenForFetch(app);
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/meds`;
  try {
    const first = await (await fetch(`${base}/search?q=alpha`)).json();
    assert.equal(first.page.total, 25); assert.equal(first.page.hasMore, true);
    const second = await (await fetch(`${base}/search?q=alpha&offset=20&revision=${first.page.revision}`)).json();
    assert.equal(second.candidates.length, 5); assert.equal(second.page.hasMore, false);
    assert.equal((await fetch(`${base}/search?q=alpha&offset=-1`)).status, 400);
    assert.equal((await fetch(`${base}/search?q=alpha&source=rxnorm&offset=20`)).status, 400);
    const response = await fetch(`${base}/match`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ observations: [{ name: '', strength: '', dosageForm: '', appearance: { color: '白', shape: '圓形', imprints: [] } }], offset: 20, revision: first.page.revision }) });
    assert.equal((await response.json()).matches[0].candidates.length, 5);
    importTfda(db, [row('NEW')]);
    const changed = await fetch(`${base}/search?q=alpha&offset=20&revision=${first.page.revision}`);
    assert.equal(changed.status, 409); assert.match((await changed.json()).error, /重新搜尋/);
    assert.equal(requests, 0);
  } finally { server.close(); await once(server, 'close'); }
});
