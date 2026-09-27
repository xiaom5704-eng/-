import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import sharp from 'sharp';
import { ReferenceOriginals, allowedOriginalUrl } from '../server/vision/reference-originals';
import { LocalMedicationImages } from '../server/medications/local-images';
import { getTfda, openDrugDatabase } from '../server/medications/store';
import { importTfda } from '../server/medications/importers';
import { importAppearance } from '../server/medications/appearance';

async function fixture(t: TestContext) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'medsafe-originals-')), db = openDrugDatabase(':memory:');
  t.after(() => {
    db.close(); assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('medsafe-originals-')); rmSync(root, { recursive: true, force: true });
  });
  const source = 'https://mcp.fda.gov.tw/insert/shapeImg/5471bb25-2072-4c17-b3dc-cb741a489500?c=o';
  importTfda(db, [{ 許可證字號: 'SYNTHETIC001', 中文品名: '合成測試錠', 英文品名: 'SYNTHETIC', 主成分略述: 'Test ingredient' }]);
  importAppearance(db, Buffer.from(`許可證字號,中文品名,英文品名,形狀,特殊劑型,顏色,特殊氣味,刻痕,外觀尺寸,標註一,標註二,外觀圖檔連結\nSYNTHETIC001,合成測試錠,SYNTHETIC,圓形,,白,,,8,AB,,${source}`), 'synthetic.csv');
  const bytes = await sharp({ create: { width: 1400, height: 900, channels: 3, background: '#aaccee' } }).png().toBuffer();
  const originals = new ReferenceOriginals(db, path.join(root, 'originals'));
  const service = new LocalMedicationImages(db, path.join(root, 'index.db'), path.join(root, 'images'));
  return { root, db, source, bytes, originals, service };
}
const respond = (body: Buffer | string, init: ResponseInit = {}) => (async () => new Response(body, init)) as typeof fetch;

test('Official references preserve resolution, provenance and offline viewing without a CV index', async t => {
  const f = await fixture(t); let calls = 0;
  const row = await f.originals.download('SYNTHETIC001', f.source, (async (url, init) => {
    calls++; assert.equal(url, f.source); assert.equal(init?.redirect, 'error'); return new Response(f.bytes);
  }) as typeof fetch);
  assert.equal(calls, 1); assert.equal(row.width, 1400); assert.equal(row.height, 900); assert.equal(row.source_width, 1400);
  assert.match(row.source_sha256, /^[a-f0-9]{64}$/); assert.notEqual(row.sha256, row.source_sha256);
  const reopened = new ReferenceOriginals(f.db, path.join(f.root, 'originals'));
  assert.deepEqual(reopened.forDrugs(['SYNTHETIC001']), [rowWithTransform(row)]);
  const original = getTfda(f.db, 'SYNTHETIC001')!, candidate = f.service.attach([original])[0];
  assert.equal(original.appearance?.localDetailImages, undefined);
  assert.equal(candidate.appearance?.localDetailImages?.[f.source].width, 1400);
  assert.equal(candidate.appearance?.localImageUrls?.[f.source], `/api/medications/reference-images/${row.sha256}.webp`);
  const image = await sharp(await readFile(f.service.fileFor(row.sha256)!)).metadata();
  assert.equal(image.width, 1400); assert.equal(image.height, 900);
});
function rowWithTransform(row: object) { return { ...row, transform: 'official-reference-webp-q95-max8192-v1' }; }

test('Failed refresh, unsupported data and excessive responses preserve the previously verified image', async t => {
  const f = await fixture(t), row = await f.originals.download('SYNTHETIC001', f.source, respond(f.bytes));
  for (const request of [respond('down', { status: 503 }), respond('<html>error</html>'), respond('huge', { headers: { 'Content-Length': '50000001' } })]) {
    await assert.rejects(f.originals.download('SYNTHETIC001', f.source, request));
    assert.equal(f.originals.forDrugs(['SYNTHETIC001'])[0].sha256, row.sha256);
    assert.ok(f.service.fileFor(row.sha256));
  }
});

test('Original downloads cannot request other hosts, unmatched licenses or source URLs; stale sources cease being served', async t => {
  const f = await fixture(t); let calls = 0;
  const forbidden = (async () => { calls++; throw new Error('must not request'); }) as typeof fetch;
  for (const url of ['http://localhost/file', 'https://mcp.fda.gov.tw@evil.example/file', f.source + '&redirect=http://localhost', f.source.replace('https:', 'http:'), f.source + '#extra']) {
    assert.equal(allowedOriginalUrl(url), false);
    await assert.rejects(f.originals.download('SYNTHETIC001', url, forbidden));
  }
  await assert.rejects(f.originals.download('OTHER', f.source, forbidden)); assert.equal(calls, 0);
  const row = await f.originals.download('SYNTHETIC001', f.source, respond(f.bytes));
  const orphan = 'b'.repeat(64); writeFileSync(path.join(f.root, 'originals/images', `${orphan}.webp`), f.bytes);
  assert.equal(f.service.fileFor(orphan), null); assert.equal(f.service.fileFor('../outside'), null);
  f.db.prepare("UPDATE tfda_appearances SET payload=json_set(payload, '$.imageUrls', json('[]'))").run();
  assert.equal(f.service.fileFor(row.sha256), null); assert.equal(f.originals.forDrugs(['SYNTHETIC001']).length, 0);
});

test('Source changes during download and deleted files never leave a usable original link', async t => {
  const f = await fixture(t);
  await assert.rejects(f.originals.download('SYNTHETIC001', f.source, (async () => {
    f.db.prepare("UPDATE tfda_appearances SET payload=json_set(payload, '$.imageUrls', json('[]'))").run(); return new Response(f.bytes);
  }) as typeof fetch), /來源已改變/);
  assert.equal(f.originals.forDrugs(['SYNTHETIC001']).length, 0);
  f.db.prepare("UPDATE tfda_appearances SET payload=json_set(payload, '$.imageUrls', json(?))").run(JSON.stringify([f.source]));
  const row = await f.originals.download('SYNTHETIC001', f.source, respond(f.bytes));
  rmSync(f.originals.fileFor(row.sha256)!);
  assert.equal(f.service.attach([getTfda(f.db, 'SYNTHETIC001')!])[0].appearance?.localDetailImages, undefined);
});

test('Official numbered image URLs remain license-scoped and survive an offline reopen', async t => {
  const f = await fixture(t);
  const numbered = f.source.replace('?c=o', '_img_1?c=o');
  assert.equal(allowedOriginalUrl(numbered), true);
  for (const url of [numbered.replace('_img_1', '_img_0'), numbered.replace('_img_1', '_img_1000'), numbered.replace('_img_1', '_img_1.exe'),
    numbered.replace('_img_1', '_img_1/extra'), numbered.replace('/shapeImg/', '/other/'), numbered + '&extra=1',
    numbered.replace('5471bb25-2072-4c17-b3dc-cb741a489500', '-'.repeat(36))]) assert.equal(allowedOriginalUrl(url), false, url);
  let calls = 0;
  const request: typeof fetch = async url => { calls++; assert.equal(url, numbered); return new Response(f.bytes); };
  await assert.rejects(f.originals.download('SYNTHETIC001', numbered, request), /目前列出/);
  assert.equal(calls, 0, 'a valid endpoint is insufficient without this product linkage');
  f.db.prepare("UPDATE tfda_appearances SET payload=json_set(payload, '$.imageUrls', json(?))").run(JSON.stringify([numbered]));
  const saved = await f.originals.download('SYNTHETIC001', numbered, request);
  assert.equal(calls, 1);
  const reopened = new ReferenceOriginals(f.db, path.join(f.root, 'originals'));
  assert.equal(reopened.forDrugs(['SYNTHETIC001'])[0].source_url, numbered);
  assert.equal(f.service.attach([getTfda(f.db, 'SYNTHETIC001')!])[0].appearance!.localDetailImages![numbered].url, `/api/medications/reference-images/${saved.sha256}.webp`);
});
