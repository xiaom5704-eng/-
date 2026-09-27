import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import sharp from 'sharp';
import AdmZip from 'adm-zip';
import express from 'express';
import { openDrugDatabase } from '../server/medications/store';
import { importTfda } from '../server/medications/importers';
import { importTfdaLabelIndex } from '../server/medications/tfda-label-index';
import { OfficialPackageReferences } from '../server/vision/official-packages';
import { PackageVisionService } from '../server/vision/packages';
import { officialPackageRouter } from '../server/vision/official-package-router';
import { listenForFetch } from './http-listener';
import { DIMENSIONS } from '../server/vision/config.mjs';
import { packagePages } from '../server/vision/package-pages';

const id = '衛署藥製字第999991號', otherId = '衛署藥製字第999992號', signal = () => new AbortController().signal;
const url = 'https://mcp.fda.gov.tw/insert/lablefiles/synthetic?c=2';
const photo = () => sharp({ create: { width: 96, height: 64, channels: 3, background: '#37664a' } }).png().toBuffer();
// Tiny synthetic PDF: distinct page colors catch accidental first-page-only rendering.
function pdfFixture(pages: number) {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', `<< /Type /Pages /Count ${pages} /Kids [${Array.from({ length: pages }, (_, i) => `${i * 2 + 3} 0 R`).join(' ')}] >>`];
  for (let i = 0; i < pages; i++) {
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources << >> /Contents ${i * 2 + 4} 0 R >>`);
    const content = `${i / pages} 0.3 0.5 rg 0 0 100 100 re f\n`;
    objects.push(`<< /Length ${content.length} >>\nstream\n${content}endstream`);
  }
  let text = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((object, i) => { offsets.push(text.length); text += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const start = text.length;
  text += `xref\n0 ${offsets.length}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
  return Buffer.from(text);
}
function enableAll(store: OfficialPackageReferences) { for (const photo of store.snapshot(id).library.photos) store.enable(photo.key); }
async function fixture(t: TestContext) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'official-package-')); const db = openDrugDatabase(':memory:');
  t.after(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  importTfda(db, [id, otherId].map(license => ({ 許可證字號: license, 中文品名: '人工測試錠', 英文品名: 'SYNTHETIC TABLET', 主成分略述: 'SYNTHETIC', 劑型: '錠劑' })));
  const z = new AdmZip(); z.addFile('39.json', Buffer.from(JSON.stringify([{ 許可證字號: id, 中文品名: '人工測試錠', 英文品名: 'SYNTHETIC TABLET', 仿單圖檔連結: '', 外盒圖檔連結: url }])));
  const metadata = importTfdaLabelIndex(db, z.toBuffer(), '2026-09-27T00:00:00Z').metadata;
  const bytes = await photo(), vector = new Float32Array(DIMENSIONS); vector[0] = 1; let requests = 0;
  const models = path.join(root, 'models'); mkdirSync(path.join(models, 'onnx'), { recursive: true }); writeFileSync(path.join(models, 'onnx/model_quantized.onnx'), 'synthetic');
  const store = new OfficialPackageReferences(db, path.join(root, 'official'), async () => vector, async (input, options) => {
    assert.equal(input, url); assert.equal(options?.redirect, 'error'); requests++; return new Response(bytes);
  });
  const vision = new PackageVisionService(db, path.join(root, 'personal/index.db'), path.join(root, 'personal/images'), models, async () => vector, store);
  return { root, db, store, vision, vector, bytes, sha: metadata.sha256!, requests: () => requests };
}

test('Official images bind only the indexed license and enable local package search with no personal gallery', async t => {
  const f = await fixture(t); assert.equal(f.vision.status().ready, false);
  assert.equal((await f.store.save(id, url, f.sha, signal())).reused, false);
  const first = f.store.snapshot(id).library.photos[0]; assert.equal(first.usable, false); assert.ok(first.pending); assert.match(first.imageUrl!, /official-images/);
  assert.equal(f.vision.status().ready, false); enableAll(f.store);
  assert.equal(f.vision.status().officialPackageImageCount, 1);
  const result = await f.vision.search([f.bytes], '', signal()); assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].drug.id, id); assert.equal(result.candidates[0].images[0].sourceUrl, url);
  assert.match(result.candidates[0].images[0].sourceNote!, /TFDA 外盒/);
  assert.equal((await f.store.save(id, url, f.sha, signal())).reused, true); assert.equal(f.requests(), 1);
  assert.equal(f.store.snapshot(id).library.photos[0].retrievedAt, first.retrievedAt);
  const reopened = new OfficialPackageReferences(f.db, path.join(f.root, 'official'), async () => f.vector, async () => { throw new Error('No network'); });
  assert.ok(reopened.snapshot(id).library.photos[0].usable); assert.equal((await reopened.save(id, url, f.sha, signal())).reused, true);
});

test('Official and personal references rank together while provenance and exact-license constraints remain separate', async t => {
  const f = await fixture(t);
  await f.vision.register([f.bytes], '人工測試錠', 'Synthetic personal reference', signal());
  await f.store.save(id, url, f.sha, signal());
  enableAll(f.store);
  assert.equal((await f.vision.search([f.bytes], '', signal())).candidates.length, 2);
  const entry = f.store.snapshot(id).library.photos[0]; f.store.disable(entry.key);
  assert.equal(f.vision.status().officialPackageImageCount, 0); assert.equal(f.vision.status().ready, true);
  assert.equal((await f.vision.search([f.bytes], '', signal())).candidates.length, 2);
  assert.ok(f.store.imagePath(path.basename(entry.imageUrl!, '.webp')), 'Disabled references remain available for offline review');
});

test('Changed product identity, removed source, damaged files and invalid vectors are excluded immediately', async t => {
  const f = await fixture(t); await f.store.save(id, url, f.sha, signal());
  enableAll(f.store);
  const entry = f.store.snapshot(id).library.photos[0], sha = path.basename(entry.imageUrl!, '.webp');
  const file = f.store.imagePath(sha)!, original = readFileSync(file);
  writeFileSync(file, 'damaged'); assert.equal(f.vision.status().ready, false); assert.equal(f.store.imagePath(sha), null);
  writeFileSync(file, original); assert.equal(f.vision.status().ready, true);
  const d = f.db.prepare('SELECT payload FROM tfda_drugs WHERE id=?').get(id) as { payload: string };
  f.db.prepare("UPDATE tfda_drugs SET payload=json_set(payload,'$.ingredients',json('[\"OTHER\"]')) WHERE id=?").run(id);
  assert.equal(f.vision.status().ready, false); f.db.prepare('UPDATE tfda_drugs SET payload=? WHERE id=?').run(d.payload, id);
  const index = new Database(path.join(f.root, 'official/index.db'));
  index.prepare('UPDATE official_package_images SET embedding=?').run(Buffer.alloc(3)); index.close();
  assert.equal(f.vision.status().ready, false);
  await f.store.save(id, url, f.sha, signal()); assert.equal(f.vision.status().ready, false, 'Repaired pages require a new review');
  enableAll(f.store); assert.equal(f.vision.status().ready, true);
  f.db.prepare("UPDATE tfda_label_index SET payload=json_set(payload,'$.packageUrls',json('[]')) WHERE id=?").run(id);
  assert.equal(f.vision.status().ready, false); assert.equal(f.store.imagePath(sha), null);
});

test('Unlisted, foreign, wrong-license and stale index requests are refused before network access', async t => {
  const f = await fixture(t);
  for (const [drugId, source, sha] of [[otherId, url, f.sha], [id, 'http://localhost/x', f.sha], [id, url + '&redirect=http://localhost', f.sha],
    [id, 'https://mcp.fda.gov.tw/insert/lablefiles/not-listed?c=2', f.sha], [id, url, '0'.repeat(64)]]) await assert.rejects(f.store.save(drugId, source, sha, signal()));
  assert.equal(f.requests(), 0); assert.equal(f.store.snapshot().references.length, 0);
});

test('Failed or cancelled downloads and changed sources during embedding never publish partial references', async t => {
  const f = await fixture(t);
  for (const response of [new Response('error', { status: 503 }), new Response('<html>not an image</html>'),
    new Response('huge', { headers: { 'content-length': '999999999' } })]) {
    const store = new OfficialPackageReferences(f.db, path.join(f.root, 'official'), async () => f.vector, async () => response);
    await assert.rejects(store.save(id, url, f.sha, signal())); assert.equal(f.store.snapshot().references.length, 0);
  }
  const controller = new AbortController();
  const store = new OfficialPackageReferences(f.db, path.join(f.root, 'official'), async () => { controller.abort(); return f.vector; }, async () => new Response(f.bytes));
  await assert.rejects(store.save(id, url, f.sha, controller.signal), { name: 'AbortError' }); assert.equal(f.store.snapshot().references.length, 0);
  const changing = new OfficialPackageReferences(f.db, path.join(f.root, 'official'), async () => {
    f.db.prepare('DELETE FROM tfda_label_index WHERE id=?').run(id); return f.vector;
  }, async () => new Response(f.bytes));
  await assert.rejects(changing.save(id, url, f.sha, signal()), /變動/); assert.equal(f.store.snapshot().references.length, 0);
});

test('HTTP saves only indexed sources, shares the model queue, serves local bytes and can disable a reference', async t => {
  const f = await fixture(t), queue = { busy: false }, app = express(); app.use(express.json()); app.use('/packages', officialPackageRouter(f.store, queue));
  const server = await listenForFetch(app); t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/packages`;
  const post = (route: string, body: unknown) => fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await post('/official-references', {})).status, 400);
  const body = { drugId: id, sourceUrl: url, indexSha256: f.sha };
  queue.busy = true; assert.equal((await post('/official-references', body)).status, 429); queue.busy = false;
  const saved = await post('/official-references', body); assert.equal(saved.status, 200);
  const entry = (await saved.json()).library.photos[0];
  const local = base + '/official-images/' + path.basename(entry.imageUrl);
  assert.equal((await fetch(local)).status, 200); assert.equal((await fetch(local)).headers.get('cache-control'), 'private, no-store');
  assert.equal(f.vision.status().ready, false);
  assert.equal((await post(`/official-references/${entry.key}/enable`, {})).status, 400);
  assert.equal((await post(`/official-references/${entry.key}/enable`, { confirmed: true })).status, 200);
  assert.equal(f.vision.status().ready, true);
  assert.equal((await post(`/official-references/${entry.key}/disable`, {})).status, 200);
  assert.equal(f.vision.status().ready, false); assert.equal((await fetch(local)).status, 200); assert.equal(f.requests(), 1);
  f.db.prepare('DELETE FROM tfda_label_index WHERE id=?').run(id);
  assert.equal((await post(`/official-references/${entry.key}/enable`, { confirmed: true })).status, 422);
  assert.equal((await fetch(local)).status, 404);
});

test('Multi-page official PDFs retain all pages and provenance, and each page requires its own review', async t => {
  const f = await fixture(t), bytes = pdfFixture(3);
  const store = new OfficialPackageReferences(f.db, path.join(f.root, 'official'), async () => f.vector, async () => new Response(bytes));
  await store.save(id, url, f.sha, signal());
  const photos = store.snapshot(id).library.photos;
  assert.deepEqual(photos.map(p => p.page), [1, 2, 3]); assert.equal(new Set(photos.map(p => p.imageUrl)).size, 3);
  assert.ok(photos.every(p => p.pending && !p.usable && p.imageUrl && p.pageCount === 3));
  store.enable(photos[0].key); assert.equal(store.snapshot().references.length, 1);
  assert.ok(store.snapshot().library.photos[1].pending);
  assert.equal((await store.save(id, url, f.sha, signal())).reused, true);
  assert.equal(store.snapshot().references.length, 1, 'Repeating save never activates unreviewed pages');
});

test('PDF page bounds, corrupt PDFs and later-page feature failures leave existing references unchanged', async t => {
  const f = await fixture(t);
  await assert.rejects(packagePages(pdfFixture(9), signal()), /8 頁/);
  await assert.rejects(packagePages(Buffer.from('%PDF-1.4\ncorrupt'), signal()));
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(packagePages(pdfFixture(2), aborted.signal), { name: 'AbortError' });
  await f.store.save(id, url, f.sha, signal()); enableAll(f.store);
  const original = f.store.snapshot(id).library;
  // A damaged original forces a rebuild, but failure on page 2 cannot publish page 1.
  const p = path.basename(original.photos[0].imageUrl!, '.webp'), image = f.store.imagePath(p)!;
  const bytes = readFileSync(image); writeFileSync(image, 'damage');
  let calls = 0;
  const failing = new OfficialPackageReferences(f.db, path.join(f.root, 'official'), async () => {
    if (++calls === 2) throw new Error('Second-page model failure'); return f.vector;
  }, async () => new Response(pdfFixture(3)));
  await assert.rejects(failing.save(id, url, f.sha, signal()), /Second-page/);
  assert.equal(calls, 2); writeFileSync(image, bytes);
  assert.deepEqual(f.store.snapshot(id).library, original);
});
