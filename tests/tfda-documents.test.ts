import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import AdmZip from 'adm-zip';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { openDrugDatabase, getTfda, type DrugDatabase } from '../server/medications/store';
import { importTfda } from '../server/medications/importers';
import { importTfdaLabelIndex, readTfdaLabelIndex } from '../server/medications/tfda-label-index';
import { TfdaDocuments, tfdaDocumentRouter } from '../server/medications/tfda-documents';
import { DrugProviders } from '../server/medications/providers';
import { medicationRouter } from '../server/medications/router';
import { reportToMarkdown, withSavedTfdaDocument } from '../shared/medication';
import { isLocalDocumentPath, validLocalDocument } from '../shared/source-document';
import MedicationLeaflets from '../src/components/MedicationLeaflets';
import MarkdownContent from '../src/components/MarkdownContent';
import { listenForFetch } from './http-listener';

const id = '衛署藥製字第999991號', url = 'https://mcp.fda.gov.tw/insert/pdfcasefile/synthetic';
const row = { 許可證字號: id, 中文品名: '人工測試錠', 英文品名: 'SYNTHETIC TABLETS', 主成分略述: 'SYNTHETIC', 劑型: '錠劑' };
// Existing public PDF fixture tests byte preservation and parsing only. Its text
// is deliberately unrelated to the synthetic product; no clinical claim is made.
const pdf = readFileSync(new URL('./fixtures/source-documents/cypromin-2012.pdf', import.meta.url));
const signal = () => new AbortController().signal;
function seed(db: DrugDatabase, links = url) {
  importTfda(db, [row]);
  const zip = new AdmZip(); zip.addFile('39.json', Buffer.from(JSON.stringify([{ ...row, 仿單圖檔連結: links, 外盒圖檔連結: '' }])));
  importTfdaLabelIndex(db, zip.toBuffer(), '2026-09-27T00:00:00Z');
}
function fixture(t: TestContext) {
  const db = openDrugDatabase(':memory:'); t.after(() => db.close()); seed(db); return db;
}
const input = (db: DrugDatabase) => ({ licenseId: id, sourceUrl: url, indexSha256: readTfdaLabelIndex(db, getTfda(db, id)!)!.sha256 });
const documentId = (url: string) => url.split('/')[4];

function emptyPages(count: number) {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', `<< /Type /Pages /Count ${count} /Kids [${Array.from({ length: count }, (_, i) => `${i + 3} 0 R`).join(' ')}] >>`,
    ...Array.from({ length: count }, () => '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources << >> >>')];
  let data = '%PDF-1.4\n'; const offsets: number[] = [];
  objects.forEach((object, i) => { offsets.push(data.length); data += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const start = data.length;
  data += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
  return Buffer.from(data);
}

test('PDF page limit rejects an unreadable-length source and a failed SQL write rolls back the new version and head', async t => {
  const db = fixture(t); let bytes = pdf;
  const store = new TfdaDocuments(db, async () => new Response(bytes));
  const saved = await store.save(input(db), signal());
  bytes = emptyPages(51); await assert.rejects(store.save({ ...input(db), refresh: true }, signal()), /50 頁/);
  bytes = emptyPages(50);
  db.exec("CREATE TRIGGER fail_head BEFORE INSERT ON tfda_document_heads BEGIN SELECT RAISE(ABORT,'synthetic failure'); END");
  await assert.rejects(store.save({ ...input(db), refresh: true }, signal()), /synthetic failure/);
  assert.equal((db.prepare('SELECT COUNT(*) n FROM tfda_documents').get() as { n: number }).n, 1);
  assert.deepEqual(await store.save(input(db), signal()), saved);
  db.exec('DROP TRIGGER fail_head');
  const next = await store.save({ ...input(db), refresh: true }, signal()); assert.notEqual(next.url, saved.url);
});

test('Official PDF is saved once, exported with provenance, survives reopen and reads offline through the real report router', async t => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'tfda-document-'));
  const file = path.join(directory, 'test.db'); let db = openDrugDatabase(file); seed(db);
  t.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
  const drugBefore = getTfda(db, id); let requests = 0;
  const store = new TfdaDocuments(db, async (source, options) => {
    requests++; assert.equal(source, url); assert.equal(options?.redirect, 'error'); return new Response(pdf);
  });
  const saved = await store.save(input(db), signal());
  assert.ok(validLocalDocument(saved)); assert.ok(isLocalDocumentPath(saved.url));
  assert.deepEqual(await store.save(input(db), signal()), saved); assert.equal(requests, 1);
  assert.deepEqual(getTfda(db, id), drugBefore);
  db.close(); db = openDrugDatabase(file);
  const offline = new TfdaDocuments(db, async () => { throw Error('Offline'); });
  assert.deepEqual(await offline.save(input(db), signal()), saved);
  const provider = new DrugProviders(db, async () => { throw Error('Unexpected external request'); });
  const report = await provider.report([getTfda(db, id)!], 'local'), original = JSON.stringify(report);
  const attached = offline.attach(report);
  assert.equal(JSON.stringify(report), original); assert.deepEqual(attached.interactions, report.interactions);
  assert.equal(attached.medications[0].localLabel, undefined);
  assert.deepEqual(attached.medications[0].taiwanLabelIndex?.documents, [saved]);
  const markdown = reportToMarkdown(attached);
  assert.ok(markdown.includes(saved.url)); assert.ok(markdown.includes(saved.sha256)); assert.match(markdown, /未人工核對/);
  assert.match(renderToStaticMarkup(createElement(MedicationLeaflets, { report: attached })), /閱讀本機 PDF/);
  assert.match(renderToStaticMarkup(createElement(MarkdownContent, { children: markdown })), /開啟本機 PDF 副本/);
  const app = express(); app.use(express.json()); app.use('/api/medications', medicationRouter(db, provider));
  const server = await listenForFetch(app); t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const response = await fetch(base + saved.url);
  assert.equal(response.headers.get('content-type'), 'application/pdf'); assert.deepEqual(Buffer.from(await response.arrayBuffer()), pdf);
  const meta = await (await fetch(base + saved.url.replace(/\.pdf$/, '.json'))).json();
  assert.equal(meta.sourceUrl, url); assert.ok(meta.title.includes(id)); assert.equal(meta.sha256, saved.sha256);
  const fromRouter = await (await fetch(`${base}/api/medications/report`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ drugs: [{ id, source: 'tfda' }] }) })).json();
  assert.deepEqual(fromRouter.medications[0].taiwanLabelIndex.documents, [saved]);
  assert.equal((await fetch(base + saved.url.replace(saved.sha256 + '.pdf', 'a'.repeat(64) + '.pdf'))).status, 404);
});

test('Refresh preserves immutable versions, original dates, and old reports even when the server reverts or is unavailable', async t => {
  const db = fixture(t); let current = pdf;
  const store = new TfdaDocuments(db, async () => new Response(current));
  const first = await store.save(input(db), signal());
  assert.deepEqual(await store.save({ ...input(db), refresh: true }, signal()), first);
  current = Buffer.concat([pdf, Buffer.from('\n% second source version\n')]);
  const second = await store.save({ ...input(db), refresh: true }, signal());
  assert.notEqual(first.url, second.url); assert.deepEqual(store.read(documentId(first.url), first.sha256)?.pdf, pdf);
  const offline = new TfdaDocuments(db, async () => { throw Error('Disconnected'); });
  await assert.rejects(offline.save({ ...input(db), refresh: true }, signal()), /保留/);
  assert.deepEqual(await offline.save(input(db), signal()), second);
  current = pdf; assert.deepEqual(await store.save({ ...input(db), refresh: true }, signal()), first);
  assert.ok(store.read(documentId(second.url), second.sha256));
  assert.equal((db.prepare('SELECT COUNT(*) n FROM tfda_documents').get() as { n: number }).n, 2);
});

test('Only canonical product links can download; changed identity or index during the request cannot attach a mismatched document', async t => {
  const db = fixture(t); let requests = 0;
  const store = new TfdaDocuments(db, async () => { requests++; return new Response(pdf); });
  const good = input(db);
  for (const change of [{ sourceUrl: 'http://127.0.0.1/private' }, { sourceUrl: url + '?next=evil' }, { sourceUrl: `https://mcp.fda.gov.tw/exportpdf/${id}` }, { indexSha256: 'a'.repeat(64) }, { licenseId: 'missing' }])
    await assert.rejects(store.save({ ...good, ...change }, signal()));
  assert.equal(requests, 0);
  const changed = new TfdaDocuments(db, async () => { importTfda(db, [{ ...row, 主成分略述: 'DIFFERENT' }]); return new Response(pdf); });
  await assert.rejects(changed.save(good, signal()), /下載期間/);
  assert.equal((db.prepare('SELECT COUNT(*) n FROM tfda_documents').get() as { n: number }).n, 0);
  seed(db); const saved = await store.save(input(db), signal());
  importTfda(db, [{ ...row, 主成分略述: 'DIFFERENT' }]);
  const report = await new DrugProviders(db).report([getTfda(db, id)!], 'local');
  assert.deepEqual(store.attach(report).medications[0].taiwanLabelIndex?.documents, []);
  assert.ok(store.read(documentId(saved.url), saved.sha256)); // Historical source still accessible.
  seed(db);
  const changedIndex = new TfdaDocuments(db, async () => { seed(db, url + '-new'); return new Response(pdf); });
  await assert.rejects(changedIndex.save({ ...input(db), refresh: true }, signal()), /索引已變動/);
});

test('HTML, broken PDF, overlong downloads, source errors and cancelled downloads never replace a good copy', async t => {
  const db = fixture(t), good = new TfdaDocuments(db, async () => new Response(pdf));
  const saved = await good.save(input(db), signal());
  for (const response of [new Response('<html>temporarily unavailable</html>'), new Response('%PDF-1.4\nbroken\n%%EOF'),
    new Response(pdf.subarray(0, -30)), new Response(new Uint8Array(5_000_001)), new Response(pdf, { headers: { 'content-length': '5000001' } }), new Response('', { status: 503 })]) {
    const store = new TfdaDocuments(db, async () => response);
    await assert.rejects(store.save({ ...input(db), refresh: true }, signal()));
    assert.deepEqual(await good.save(input(db), signal()), saved);
  }
  const abort = new AbortController();
  const interrupted = new TfdaDocuments(db, async (_url, options) => { abort.abort(); assert.ok(options?.signal?.aborted); return new Response(pdf); });
  await assert.rejects(interrupted.save({ ...input(db), refresh: true }, abort.signal));
  assert.deepEqual(await good.save(input(db), signal()), saved);
  let requests = 0; const alreadyCancelled = new TfdaDocuments(db, async () => { requests++; return new Response(pdf); });
  await assert.rejects(alreadyCancelled.save(input(db), abort.signal)); assert.equal(requests, 0);
});

test('Corrupt metadata or bytes are unavailable, and same PDF for a different product has distinct provenance URLs', async t => {
  const db = fixture(t), store = new TfdaDocuments(db, async () => new Response(pdf));
  const first = await store.save(input(db), signal());
  importTfda(db, [{ ...row, 中文品名: '人工新版品名' }]);
  const zip = new AdmZip(); zip.addFile('39.json', Buffer.from(JSON.stringify([{ ...row, 中文品名: '人工新版品名', 仿單圖檔連結: url, 外盒圖檔連結: '' }])));
  importTfdaLabelIndex(db, zip.toBuffer(), '2026-09-28T00:00:00Z');
  const second = await store.save(input(db), signal()); assert.notEqual(first.url, second.url); assert.equal(first.sha256, second.sha256);
  assert.ok(store.read(documentId(first.url), first.sha256)?.title.includes('人工測試錠'));
  assert.ok(store.read(documentId(second.url), second.sha256)?.title.includes('人工新版品名'));
  db.prepare('UPDATE tfda_documents SET metadata=? WHERE id=?').run('{}', documentId(first.url));
  assert.equal(store.read(documentId(first.url), first.sha256), undefined);
  db.prepare('UPDATE tfda_documents SET pdf=? WHERE id=?').run(Buffer.alloc(pdf.length), documentId(second.url));
  assert.equal(store.read(documentId(second.url), second.sha256), undefined);
  const restored = await store.save(input(db), signal()); assert.ok(store.read(documentId(restored.url), restored.sha256));
});

test('Report update replaces only the selected source, rejects stale identity, and leaves previous report snapshots unchanged', async t => {
  const db = fixture(t), store = new TfdaDocuments(db, async () => new Response(pdf));
  const report = await new DrugProviders(db).report([getTfda(db, id)!], 'local'), index = report.medications[0].taiwanLabelIndex!;
  const saved = await store.save(input(db), signal()), updated = withSavedTfdaDocument(report, index, saved);
  assert.equal(report.medications[0].taiwanLabelIndex?.documents, undefined);
  assert.deepEqual(updated.medications[0].taiwanLabelIndex?.documents, [saved]);
  for (const change of [{ name: 'OTHER' }, { sha256: 'a'.repeat(64) }, { licenseId: 'OTHER' }])
    assert.deepEqual(withSavedTfdaDocument(report, { ...index, ...change }, saved), report);
  for (const change of [{ url: 'https://untrusted.example/x.pdf' }, { sha256: '0'.repeat(64) }, { sourceUrl: url + 'wrong' }])
    assert.deepEqual(withSavedTfdaDocument(report, index, { ...saved, ...change }), report);
  assert.equal(isLocalDocumentPath(saved.url + '?x=1'), false);
});

test('HTTP save validates inputs, serializes downloads, and returns recoverable failures without touching old copies', async t => {
  const db = fixture(t); let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void; const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
  const store = new TfdaDocuments(db, async () => { entered(); await waiting; return new Response(pdf); });
  const app = express(); app.use(express.json()); app.use('/docs', tfdaDocumentRouter(store));
  const server = await listenForFetch(app); t.after(() => { release(); server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/docs`;
  const send = (body: unknown) => fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await send({})).status, 400); assert.equal((await send({ ...input(db), refresh: 'yes' })).status, 400);
  const first = send(input(db)); await enteredPromise;
  assert.equal((await send(input(db))).status, 429); release(); assert.equal((await first).status, 200);
  assert.equal((await send({ ...input(db), sourceUrl: 'https://evil.invalid' })).status, 422);
  assert.equal((await send(input(db))).status, 200);
});
