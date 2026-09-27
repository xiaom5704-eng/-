import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { openDrugDatabase, getTfda, datasetStatus } from '../server/medications/store';
import { importTfda } from '../server/medications/importers';
import { importTfdaLabelIndex, parseTfdaLabelIndex, readTfdaLabelIndex } from '../server/medications/tfda-label-index';
import { applyTfdaLabelFile, bundledLabelRetrievedAt, bundledLabelSha256, readBundledLabelIndex } from '../scripts/tfda-label-bundle';
import { DrugProviders } from '../server/medications/providers';
import { reportToMarkdown } from '../shared/medication';

const id = '衛署藥製字第999991號', date = '2026-09-27T01:02:03Z';
const row = (extra = {}) => ({ 許可證字號: id, 中文品名: '人工測試錠', 英文品名: 'SYNTHETIC TABLETS',
  仿單圖檔連結: `https://mcp.fda.gov.tw/exportpdf/${id}`, 外盒圖檔連結: 'https://mcp.fda.gov.tw/insert/lablefiles/synthetic?c=2', ...extra });
function zip(rows: unknown = [row()]) { const z = new AdmZip(); z.addFile('39.json', Buffer.from(JSON.stringify(rows))); return z.toBuffer(); }
function fixture(t: TestContext, filename = ':memory:') {
  const db = openDrugDatabase(filename); t.after(() => db.close());
  importTfda(db, [{ ...row(), 主成分略述: 'SYNTHETIC INGREDIENT', 有效日期: '2099/01/01' }]);
  return db;
}

test('Official ZIP is hash-pinned and retains every licensed entry and source link', async () => {
  const bytes = await readBundledLabelIndex(), rows = parseTfdaLabelIndex(bytes);
  assert.equal(rows.length, 29875);
  assert.equal(rows.filter(r => r.labelUrls.length).length, 27550);
  assert.equal(rows.reduce((count, r) => count + r.unavailableLabelLinks, 0), 12);
  assert.ok(!rows.find(r => r.licenseId === '衛署藥製字第028605號')!.labelUrls.includes('https://mcp.fda.gov.tw/insert/pdfcase'));
  assert.equal(rows.filter(r => r.packageUrls.length).length, 20961);
  assert.equal(rows.find(r => r.licenseId === '衛署藥製字第018098號')!.labelUrls[0],
    'https://mcp.fda.gov.tw/insert/pdfcasefile/i_dc48229e-ee74-45b8-9503-ca1da3e427a1?c=2');
  assert.equal(rows.find(r => r.licenseId === '衛部藥製字第060563號')!.labelUrls[0], 'https://mcp.fda.gov.tw/exportpdf/衛部藥製字第060563號');
});

test('Offline reports attach exact product links, keep interaction evidence, and export provenance without fetching documents', async t => {
  const db = fixture(t), drug = getTfda(db, id)!; let requests = 0;
  const provider = new DrugProviders(db, async () => { requests++; throw new Error('No external requests allowed'); });
  const before = await provider.report([drug], 'local');
  importTfdaLabelIndex(db, zip([row({ 仿單圖檔連結: `https://mcp.fda.gov.tw/exportpdf/${id};https://mcp.fda.gov.tw/insert/pdfcasefile/synthetic?c=2` })]), date);
  const after = await provider.report([drug], 'local');
  assert.equal(requests, 0); assert.deepEqual(after.interactions, before.interactions);
  assert.deepEqual(after.medications[0].ingredients, before.medications[0].ingredients);
  assert.deepEqual(after.medications[0].labels, []); assert.equal(after.medications[0].localLabel, undefined);
  const index = after.medications[0].taiwanLabelIndex!;
  assert.equal(index.licenseId, id); assert.equal(index.labelUrls.length, 2); assert.equal(index.packageUrls.length, 1);
  assert.equal(index.retrievedAt, date); assert.equal(index.sourceUrl, 'https://data.gov.tw/dataset/9117');
  assert.equal(datasetStatus(db).find(s => s.source === 'tfda_labels')!.count, 1);
  const markdown = reportToMarkdown(after);
  assert.match(markdown, /原始文件需連線開啟/); assert.ok(markdown.includes(index.sha256)); assert.ok(markdown.includes(date));
  assert.match(markdown, /官方外盒圖 1/);
});

test('Same license with changed names, strengths, or source cannot inherit the links', t => {
  const db = fixture(t), drug = getTfda(db, id)!;
  importTfdaLabelIndex(db, zip(), date);
  assert.ok(readTfdaLabelIndex(db, drug));
  assert.ok(readTfdaLabelIndex(db, { ...drug, englishName: 'ｓｙｎｔｈｅｔｉｃ  ｔａｂｌｅｔｓ' }));
  for (const change of [{ id: '衛署藥製字第999992號' }, { name: drug.name + '2毫克' }, { englishName: 'OTHER' },
    { source: 'rxnorm' as const }, { appearanceOnly: true }]) assert.equal(readTfdaLabelIndex(db, { ...drug, ...change }), undefined);
  db.prepare('UPDATE tfda_label_index SET payload=?').run('{broken');
  assert.equal(readTfdaLabelIndex(db, drug), undefined);
});

test('Malformed archives, duplicates, unsafe links and wrong-license redirects never replace the previous index', t => {
  const db = fixture(t); importTfdaLabelIndex(db, zip(), date);
  const before = db.serialize();
  for (const value of [[], [row(), row()], [row({ 許可證字號: '' })], [row({ 中文品名: 42 })],
    [row({ 仿單圖檔連結: 'https://mcp.fda.gov.tw/exportpdf/衛署藥製字第999992號' })],
    [row({ 仿單圖檔連結: 'https://mcp.fda.gov.tw.attacker.example/insert/pdfcasefile/test' })],
    [row({ 外盒圖檔連結: 'javascript:alert(1)' })], [row({ 仿單圖檔連結: 'https://user:pass@mcp.fda.gov.tw/insert/pdfcasefile/test' })],
    [row({ 仿單圖檔連結: 'https://mcp.fda.gov.tw/insert/pdfcasefile/test?redirect=http://localhost' })]]) {
    assert.throws(() => importTfdaLabelIndex(db, zip(value), date)); assert.deepEqual(db.serialize(), before);
  }
  const ambiguous = new AdmZip(zip()); ambiguous.addFile('extra.json', Buffer.from('[]'));
  for (const bytes of [ambiguous.toBuffer(), Buffer.from('not zip')]) {
    assert.throws(() => importTfdaLabelIndex(db, bytes, date)); assert.deepEqual(db.serialize(), before);
  }
});

test('SQL failure rolls back the complete snapshot, and repeat/bundled imports preserve existing dates and versions', t => {
  const db = fixture(t), original = zip();
  importTfdaLabelIndex(db, original, date);
  assert.equal(importTfdaLabelIndex(db, original, '2026-09-28').imported, false);
  assert.equal(readTfdaLabelIndex(db, getTfda(db, id)!)!.retrievedAt, date);
  const next = zip([row({ 外盒圖檔連結: '' })]);
  assert.equal(importTfdaLabelIndex(db, next, '2026-09-28', { onlyIfMissing: true }).imported, false);
  assert.equal(readTfdaLabelIndex(db, getTfda(db, id)!)!.packageUrls.length, 1);
  db.exec("CREATE TRIGGER fail_labels BEFORE INSERT ON tfda_label_index BEGIN SELECT RAISE(ABORT,'synthetic failure'); END");
  assert.throws(() => importTfdaLabelIndex(db, next, '2026-09-28'), /synthetic failure/);
  assert.equal(readTfdaLabelIndex(db, getTfda(db, id)!)!.packageUrls.length, 1);
  db.exec('DROP TRIGGER fail_labels');
  assert.equal(importTfdaLabelIndex(db, next, '2026-09-28').imported, true);
  assert.equal(readTfdaLabelIndex(db, getTfda(db, id)!)!.packageUrls.length, 0);
});

test('Bundled installer supports an old database and survives reopen without changing drug records', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tfda-label-test-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const filename = path.join(dir, 'drugs.db'), db = openDrugDatabase(filename);
  importTfda(db, [{ ...row(), 主成分略述: 'SYNTHETIC INGREDIENT' }]);
  db.exec('DROP TABLE tfda_label_index'); const original = getTfda(db, id); db.close();
  const result = await applyTfdaLabelFile(filename, { backup: true });
  assert.equal(result.metadata.count, 29875); assert.equal(result.metadata.sha256, bundledLabelSha256);
  assert.equal(result.metadata.importedAt, bundledLabelRetrievedAt); assert.ok(result.backupPath);
  assert.equal((await applyTfdaLabelFile(filename)).imported, false);
  const reopened = openDrugDatabase(filename);
  try { assert.deepEqual(getTfda(reopened, id), original); assert.equal(datasetStatus(reopened).find(s => s.source === 'tfda_labels')!.count, 29875); }
  finally { reopened.close(); }
  const backup = openDrugDatabase(result.backupPath!);
  try { assert.equal(datasetStatus(backup).find(s => s.source === 'tfda_labels')!.count, 0); assert.deepEqual(getTfda(backup, id), original); }
  finally { backup.close(); }
  await assert.rejects(applyTfdaLabelFile(path.join(dir, 'missing.db')));
});
