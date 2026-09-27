import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { once } from 'node:events';
import { listenForFetch } from './http-listener';
import Database from 'better-sqlite3';
import express from 'express';
import sharp from 'sharp';
import { LocalMedicationImages } from '../server/medications/local-images';
import { getTfda, openDrugDatabase } from '../server/medications/store';
import { importTfda } from '../server/medications/importers';
import { importAppearance } from '../server/medications/appearance';
import { medicationRouter } from '../server/medications/router';
import { DrugProviders } from '../server/medications/providers';

async function fixture(t: TestContext) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'medication-local-images-'));
  const db = openDrugDatabase(':memory:');
  const indexPath = path.join(root, 'index.db'), images = path.join(root, 'images');
  mkdirSync(images);
  const index = new Database(indexPath);
  t.after(() => {
    index.close(); db.close();
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('medication-local-images-'));
    rmSync(root, { recursive: true, force: true });
  });
  importTfda(db, [{ 許可證字號: 'TEST001', 中文品名: '人工測試錠', 英文品名: 'SYNTHETIC', 主成分略述: 'Alpha' }]);
  const source = 'https://mcp.fda.gov.tw/test-one.webp', missing = 'https://mcp.fda.gov.tw/test-two.webp';
  const csv = `許可證字號,中文品名,英文品名,形狀,特殊劑型,顏色,特殊氣味,刻痕,外觀尺寸,標註一,標註二,外觀圖檔連結\nTEST001,人工測試錠,SYNTHETIC,圓形,,白,,,8,AB,,${source};;;${missing}`;
  importAppearance(db, Buffer.from(csv), 'synthetic.csv');
  index.exec('CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE images(drug_id TEXT,source_url TEXT,sha256 TEXT,model TEXT);');
  index.prepare('INSERT INTO metadata VALUES (?,?)').run('index', JSON.stringify({ state: 'ready', kind: 'pill', modelVersion: 'synthetic' }));
  const sha = 'a'.repeat(64), orphan = 'b'.repeat(64);
  const bytes = await sharp({ create: { width: 16, height: 16, channels: 3, background: '#fff' } }).webp().toBuffer();
  for (const hash of [sha, orphan]) writeFileSync(path.join(images, `${hash}.webp`), bytes);
  index.prepare('INSERT INTO images VALUES(?,?,?,?)').run('TEST001', source, sha, 'synthetic');
  return { db, index, root, images, indexPath, source, missing, sha, orphan, bytes, service: new LocalMedicationImages(db, indexPath, images) };
}

test('Downloaded references work without model files and retain exact source URLs plus partial-download state', async t => {
  const f = await fixture(t);
  const original = getTfda(f.db, 'TEST001')!;
  const candidate = f.service.attach([original])[0];
  assert.deepEqual(candidate.ingredients, original.ingredients);
  assert.deepEqual(candidate.appearance!.imageUrls, [f.source, f.missing]);
  assert.deepEqual(candidate.appearance!.localImageUrls, { [f.source]: `/api/medications/reference-images/${f.sha}.webp` });
  assert.equal(original.appearance!.localImageUrls, undefined, 'does not mutate source data');
  assert.equal(f.service.fileFor(f.sha), path.join(f.images, `${f.sha}.webp`));
  assert.equal(f.service.fileFor(f.orphan), null, 'files outside the index cannot be served');
  assert.equal(f.service.fileFor('../outside'), null);
});

test('Source updates, wrong index kind and missing files stop stale images immediately', async t => {
  const f = await fixture(t);
  const original = getTfda(f.db, 'TEST001')!;
  f.index.prepare('UPDATE metadata SET value=?').run(JSON.stringify({ state: 'ready', kind: 'package', modelVersion: 'synthetic' }));
  assert.equal(f.service.fileFor(f.sha), null);
  f.index.prepare('UPDATE metadata SET value=?').run(JSON.stringify({ state: 'ready', kind: 'pill', modelVersion: 'synthetic' }));
  f.db.prepare("UPDATE tfda_appearances SET payload=json_set(payload, '$.imageUrls', json('[]'))").run();
  assert.equal(f.service.fileFor(f.sha), null);
  assert.equal(f.service.attach([getTfda(f.db, 'TEST001')!])[0].appearance!.localImageUrls, undefined);
  // A removed file must not leave a false local-download badge.
  rmSync(path.join(f.images, `${f.sha}.webp`));
  assert.equal(f.service.attach([original])[0].appearance!.localImageUrls, undefined);
});

test('Search, observation and report APIs supply usable local pictures without contacting a provider', async t => {
  const f = await fixture(t); let requests = 0;
  const providers = new DrugProviders(f.db, (async () => { requests++; throw new Error('No external requests'); }) as typeof fetch);
  const app = express(); app.use(express.json()); app.use('/api/medications', medicationRouter(f.db, providers, f.service));
  const server = await listenForFetch(app);
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const post = (endpoint: string, body: unknown) => fetch(`${origin}/api/medications/${endpoint}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const result = await (await fetch(`${origin}/api/medications/search?q=synthetic`)).json();
    const url = result.candidates[0].appearance.localImageUrls[f.source];
    const image = await fetch(origin + url);
    assert.equal(image.status, 200); assert.match(image.headers.get('content-type')!, /image\/webp/);
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), f.bytes);
    const observed = await (await post('match', { observations: [{ name: '', strength: '', dosageForm: '', appearance: { shape: '圓形', color: '白', imprints: ['AB'] } }] })).json();
    assert.equal(observed.matches[0].candidates[0].appearance.localImageUrls[f.source], url);
    const report = await (await post('report', { drugs: [{ source: 'tfda', id: 'TEST001' }], mode: 'local' })).json();
    assert.equal(report.medications[0].drug.appearance.localImageUrls[f.source], url);
    assert.equal((await fetch(`${origin}/api/medications/reference-images/${f.orphan}.webp`)).status, 404);
    assert.equal(requests, 0);
  } finally { server.close(); await once(server, 'close'); }
});
