import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import express from 'express';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { listenForFetch } from './http-listener';
import { openDrugDatabase, getTfda, type DrugDatabase } from '../server/medications/store';
import { importTfda } from '../server/medications/importers';
import { attachSourceDocuments, documentHash, documentSources, importSourceDocument, readSourceDocument } from '../server/medications/source-documents';
import { DrugProviders } from '../server/medications/providers';
import { medicationRouter } from '../server/medications/router';
import { verifiedProductLabel } from '../server/medications/verified-names';
import { caseProducts } from '../shared/medication-safety';
import { escapeMarkdown, reportToMarkdown, type MedicationReport } from '../shared/medication';
import MedicationLeaflets from '../src/components/MedicationLeaflets';
import MarkdownContent from '../src/components/MarkdownContent';

const bytes = readFileSync(new URL('./fixtures/source-documents/cypromin-2012.pdf', import.meta.url));
const spec = documentSources[1], date = '2026-09-23T15:00:00.000Z';
const opened: DrugDatabase[] = [];
afterEach(() => opened.splice(0).forEach(db => db.close()));
// Test-only products retain the reviewed license/ingredients to exercise identity checks.
const rows = caseProducts.map(p => ({ 許可證字號: p.id, 中文品名: `人工 ${p.articleName}`, 英文品名: p.articleName,
  主成分略述: p.ingredients.join(';;'), 劑型: '測試', 註銷狀態: '', 有效日期: '', 申請商名稱: '', 適應症: '', 用法用量: '' }));
function setup() { const db = openDrugDatabase(':memory:'); opened.push(db); importTfda(db, rows); return db; }

test('Reviewed PDF requires exact source hash and matching full product identity; invalid import preserves the old copy', () => {
  const db = setup();
  importSourceDocument(db, spec.id, bytes, date);
  assert.equal(documentHash(bytes), spec.sha256);
  for (const data of [Buffer.from('<html>Unavailable</html>'), bytes.subarray(0, -10), Buffer.concat([bytes, Buffer.from('changed')]), Buffer.alloc(5_000_001)])
    assert.throws(() => importSourceDocument(db, spec.id, data, date));
  assert.throws(() => importSourceDocument(db, 'unreviewed', bytes, date));
  assert.throws(() => importSourceDocument(db, spec.id, bytes, 'invalid date'));
  assert.deepEqual(readSourceDocument(db, spec.sha256)?.pdf, bytes);
  importTfda(db, rows.map(row => row.許可證字號 === spec.product.id ? { ...row, 主成分略述: 'UNRELATED' } : row));
  assert.throws(() => importSourceDocument(db, spec.id, bytes, date), /成分/);
  assert.equal(verifiedProductLabel(getTfda(db, spec.product.id)!), undefined);
  assert.equal(verifiedProductLabel({ source: 'tfda', id: '衛署藥輸字第023784號', ingredients: ['UNRELATED'] }), undefined);
});

test('Same bytes retain acquisition date; corrupted source metadata or PDF is not presented as available', () => {
  const db = setup(); importSourceDocument(db, spec.id, bytes, date);
  importSourceDocument(db, spec.id, bytes, '2026-09-24T00:00:00Z');
  assert.equal(readSourceDocument(db, spec.sha256)?.metadata.retrievedAt, date);
  db.prepare('UPDATE local_source_documents SET source_url=?').run('https://wrong.invalid');
  assert.equal(readSourceDocument(db, spec.sha256), undefined);
  importSourceDocument(db, spec.id, bytes, date);
  db.prepare('UPDATE local_source_documents SET pdf=?').run(Buffer.from('%PDF-corrupt %%EOF'));
  assert.equal(readSourceDocument(db, spec.sha256), undefined);
  importSourceDocument(db, spec.id, bytes, date);
  assert.equal(readSourceDocument(db, spec.sha256)?.pdf.length, bytes.length);
});

test('Offline report attaches the PDF to the right product and source version without changing age findings or old reports', async () => {
  const db = setup(); importSourceDocument(db, spec.id, bytes, date); let external = 0;
  const provider = new DrugProviders(db, async () => { external++; throw Error('Unexpected network'); });
  const report = await provider.report(caseProducts.map(p => getTfda(db,p.id)!), 'local', { age: { value: '1', unit: 'months' }, premature: 'unknown' });
  const before = JSON.stringify(report), result = attachSourceDocuments(db, report);
  assert.equal(external, 0); assert.equal(JSON.stringify(report), before);
  assert.equal(result.safety!.alerts.length, 9);
  assert.equal(result.medications.filter(m => m.localLabel?.document).length, 1);
  assert.equal(result.medications[2].localLabel?.document?.sha256, spec.sha256);
  const sources = result.safety!.alerts.flatMap(alert => alert.sources);
  assert.ok(sources.some(source => source.url === spec.source.url && source.document));
  assert.ok(sources.filter(source => source.url !== spec.source.url).every(source => !source.document));
  const markdown = reportToMarkdown(result);
  assert.ok(markdown.includes(escapeMarkdown(date))); assert.ok(markdown.includes(spec.sha256));
  assert.ok(markdown.includes('開啟本機 PDF 副本'));
  assert.ok(renderToStaticMarkup(createElement(MedicationLeaflets, { report: result })).includes('閱讀本機 PDF（不用連外）'));
  result.medications[2].localLabel!.document!.url = 'https://untrusted.invalid';
  assert.ok(!reportToMarkdown(result).includes('untrusted.invalid'));
});

test('PDF route serves exact bytes locally, preserves unavailable state, and demo carries matching source metadata', async () => {
  const db = setup(); importSourceDocument(db, spec.id, bytes, date);
  const provider = new DrugProviders(db, async () => { throw Error('Unexpected network'); });
  const app = express(); app.use(express.json()); app.use('/api/medications', medicationRouter(db, provider));
  const server = await listenForFetch(app), base = `http://127.0.0.1:${(server.address() as {port:number}).port}`;
  try {
    const demoResponse = await fetch(`${base}/api/medications/demo`,{method:'POST'});
    assert.equal(demoResponse.status,200);
    const report = await demoResponse.json() as MedicationReport;
    const doc = report.medications[2].localLabel!.document!;
    const metadata = await (await fetch(`${base}${doc.url.replace(/\.pdf$/,'.json')}`)).json();
    assert.equal(metadata.sha256,spec.sha256); assert.equal(metadata.byteLength,bytes.length);
    assert.ok(metadata.title.includes('2012-02-22')); assert.equal(metadata.pdf,undefined);
    const response = await fetch(`${base}${doc.url}`);
    assert.equal(response.status,200); assert.match(response.headers.get('content-type')!,/application\/pdf/);
    assert.equal(response.headers.get('x-content-type-options'),'nosniff');
    assert.equal(documentHash(new Uint8Array(await response.arrayBuffer())),spec.sha256);
    for (const file of ['bad.pdf',`${'a'.repeat(64)}.pdf`,`${spec.sha256}.html`]) assert.equal((await fetch(`${base}/api/medications/source-documents/${file}`)).status,404);
    db.prepare('UPDATE local_source_documents SET pdf=?').run(Buffer.from('bad'));
    assert.equal((await fetch(`${base}${doc.url}`)).status,404);
    assert.equal((await fetch(`${base}${doc.url.replace(/\.pdf$/,'.json')}`)).status,404);
    const refreshed = await (await fetch(`${base}/api/medications/demo`,{method:'POST'})).json() as MedicationReport;
    assert.equal(refreshed.medications[2].localLabel!.document,undefined);
  } finally { await new Promise<void>(resolve=>server.close(()=>resolve())); }
});

test('Saved-report PDF links use the in-app reader without intercepting external or unrelated links', () => {
  const local=`/api/medications/source-documents/${spec.sha256}.pdf`;
  const html=renderToStaticMarkup(createElement(MarkdownContent,{children:`[開啟本機 PDF 副本](${local})\n\n[外部來源](https://example.test/source.pdf)\n\n[其他檔案](/other.pdf)`}));
  assert.ok(html.includes('<button')); assert.ok(!html.includes(`href="${local}"`));
  assert.ok(html.includes('href="https://example.test/source.pdf"')); assert.ok(html.includes('href="/other.pdf"'));
});
