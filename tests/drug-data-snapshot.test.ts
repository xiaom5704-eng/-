import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { drugDownloads, snapshotName, syncDrugData } from '../scripts/drug-data-snapshot';
import { openDrugDatabase, datasetStatus, getTfda } from '../server/medications/store';
import { importDdinter, importTfda } from '../server/medications/importers';

const row = (name: string) => ({ 許可證字號: 'SYNTHETIC001', 中文品名: name, 主成分略述: 'Alpha' });
const header = 'DDInterID_A,Drug_A,DDInterID_B,Drug_B,Level\n';
const oldCsv = `${header}DDInter1,Alpha,DDInter2,Beta,Major\n`;
const noNetwork = (async () => assert.fail('Offline import must not access the network')) as typeof fetch;
function sourceFiles(name = '更新後測試品') {
  const zip = new AdmZip(); zip.addFile('tfda.json', Buffer.from(JSON.stringify([row(name)])));
  return drugDownloads.map((source, index) => ({ ...source, data: index ? Buffer.from(`${header}DDInter1,Alpha,DDInter${index + 2},Ingredient${index},Minor\n`) : zip.toBuffer() }));
}
function respond(files = sourceFiles()) {
  let calls = 0;
  return { get calls() { return calls; }, request: (async url => {
    calls++; const source = files.find(file => file.url === String(url));
    assert.ok(source, 'Only the fixed official source URLs are used');
    return new Response(new Uint8Array(source.data));
  }) as typeof fetch };
}
async function fixture(t: TestContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'medsafe-data-sync-'));
  const db = openDrugDatabase(path.join(directory, 'drugs.db'));
  importTfda(db, [row('原始測試品')], '2020-01-01T00:00:00Z');
  importDdinter(db, [{ name: 'synthetic.csv', csv: oldCsv }], '2020-01-01T00:00:00Z');
  db.prepare('INSERT INTO ingredient_registry(key,payload) VALUES(?,?)').run('preserved', '{}');
  const raw = path.join(directory, 'raw'); await mkdir(raw);
  await writeFile(path.join(raw, 'appearance.zip'), 'untouched appearance archive');
  t.after(async () => {
    if (db.open) db.close();
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('medsafe-data-sync-'));
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, raw, db };
}

test('All nine sources publish as one verified bundle and reimport after database reopen without network', async t => {
  const { db, directory, raw } = await fixture(t), requests = respond();
  const statuses = await syncDrugData(db, { directory: raw, request: requests.request });
  assert.equal(requests.calls, 9); assert.deepEqual(statuses.map(s => s.count), [1, 8]);
  assert.equal(getTfda(db, 'SYNTHETIC001')?.name, '更新後測試品');
  assert.ok(db.prepare('SELECT * FROM ingredient_registry WHERE key=?').get('preserved'));
  assert.equal(await readFile(path.join(raw, 'appearance.zip'), 'utf8'), 'untouched appearance archive');
  const original = await readFile(path.join(raw, snapshotName));
  const archive = new AdmZip(original), manifest = JSON.parse(archive.readAsText('manifest.json'));
  assert.deepEqual(manifest.files.map((file: { url: string }) => file.url), drugDownloads.map(file => file.url));
  assert.ok(manifest.files.every((file: { sha256: string }) => /^[a-f0-9]{64}$/.test(file.sha256)));
  db.close();
  const restored = openDrugDatabase(path.join(directory, 'recovered.db'));
  try {
    await syncDrugData(restored, { directory: raw, offline: true, request: noNetwork });
    assert.equal(getTfda(restored, 'SYNTHETIC001')?.name, '更新後測試品');
    assert.equal(datasetStatus(restored)[1].count, 8);
    assert.deepEqual(await readFile(path.join(raw, snapshotName)), original);
  } finally { restored.close(); }
  assert.deepEqual((await readdir(raw)).sort(), ['appearance.zip', snapshotName].sort());
});

test('Mid-download HTTP and stream failures preserve the entire prior offline bundle and both SQL sources', async t => {
  const { db, raw } = await fixture(t);
  await syncDrugData(db, { directory: raw, request: respond(sourceFiles('可用版本')).request });
  const original = await readFile(path.join(raw, snapshotName)), metadata = datasetStatus(db);
  for (const mode of ['http', 'stream']) {
    let calls = 0;
    const good = respond(sourceFiles('不可發布')).request;
    const request = (async (url, init) => {
      if (++calls === 5) return mode === 'http' ? new Response('maintenance', { status: 503 }) : new Response(new ReadableStream({
        start(controller) { controller.enqueue(new Uint8Array([1, 2, 3])); },
        pull(controller) { controller.error(new Error('Connection interrupted')); },
      }));
      return good(url, init);
    }) as typeof fetch;
    await assert.rejects(syncDrugData(db, { directory: raw, request }), /503|Connection interrupted/);
    assert.deepEqual(await readFile(path.join(raw, snapshotName)), original);
    assert.deepEqual(datasetStatus(db), metadata);
    assert.equal(getTfda(db, 'SYNTHETIC001')?.name, '可用版本');
  }
  assert.ok(!(await readdir(raw)).some(name => name.endsWith('.partial')));
});

test('Invalid ZIP, malformed CSV and conflicting levels never replace a validated source snapshot', async t => {
  const { db, raw } = await fixture(t);
  await syncDrugData(db, { directory: raw, request: respond(sourceFiles('可用版本')).request });
  const original = await readFile(path.join(raw, snapshotName)), metadata = datasetStatus(db);
  for (const mode of ['html', 'csv', 'conflict']) {
    const files = sourceFiles('不可發布');
    if (mode === 'html') files[0].data = Buffer.from('<html>maintenance</html>');
    else if (mode === 'csv') files[8].data = Buffer.from('Unexpected,Schema\n1,2\n');
    else files[8].data = Buffer.from(`${header}DDInter1,Alpha,DDInter3,Ingredient1,Major\n`);
    await assert.rejects(syncDrugData(db, { directory: raw, request: respond(files).request }));
    assert.deepEqual(await readFile(path.join(raw, snapshotName)), original);
    assert.deepEqual(datasetStatus(db), metadata);
    assert.equal(getTfda(db, 'SYNTHETIC001')?.name, '可用版本');
    assert.ok(!(await readdir(raw)).some(name => name.endsWith('.partial')));
  }
});

test('Failure to publish the offline file rolls back the database and cleans only its own temporary file', async t => {
  const { db, raw } = await fixture(t), before = datasetStatus(db);
  const blocked = path.join(raw, snapshotName); await mkdir(blocked);
  await writeFile(path.join(blocked, 'preserve.txt'), 'owned by another process');
  await assert.rejects(syncDrugData(db, { directory: raw, request: respond().request }));
  assert.deepEqual(datasetStatus(db), before);
  assert.equal(getTfda(db, 'SYNTHETIC001')?.name, '原始測試品');
  assert.equal(await readFile(path.join(blocked, 'preserve.txt'), 'utf8'), 'owned by another process');
  assert.ok(!(await readdir(raw)).some(name => name.endsWith('.partial')));
});

test('Existing loose files remain usable offline, but a corrupt newer bundle never falls back to stale files', async t => {
  const { db, raw } = await fixture(t);
  for (const file of sourceFiles('舊格式版本')) await writeFile(path.join(raw, file.name), file.data);
  await syncDrugData(db, { directory: raw, offline: true, request: noNetwork });
  assert.equal(getTfda(db, 'SYNTHETIC001')?.name, '舊格式版本');
  await syncDrugData(db, { directory: raw, request: respond().request });
  const archive = new AdmZip(await readFile(path.join(raw, snapshotName)));
  archive.updateFile(drugDownloads[1].name, Buffer.from(oldCsv));
  await writeFile(path.join(raw, snapshotName), archive.toBuffer());
  const metadata = datasetStatus(db);
  await assert.rejects(syncDrugData(db, { directory: raw, offline: true, request: noNetwork }), /不符|校驗失敗/);
  assert.deepEqual(datasetStatus(db), metadata);
  assert.equal(getTfda(db, 'SYNTHETIC001')?.name, '更新後測試品');
});

test('Same-size corruption, invalid provenance and missing bundle entries are rejected before changing SQL', async t => {
  const { db, raw } = await fixture(t);
  await syncDrugData(db, { directory: raw, request: respond().request });
  const good = await readFile(path.join(raw, snapshotName)), before = datasetStatus(db);
  for (const mode of ['hash', 'null', 'missing', 'source']) {
    const archive = new AdmZip(good);
    if (mode === 'hash') {
      const bytes = archive.getEntry(drugDownloads[1].name)!.getData(); bytes[bytes.length - 2] ^= 1;
      archive.updateFile(drugDownloads[1].name, bytes);
    } else if (mode === 'null') archive.updateFile('manifest.json', Buffer.from('null'));
    else if (mode === 'missing') archive.deleteFile(drugDownloads[1].name);
    else {
      const manifest = JSON.parse(archive.readAsText('manifest.json')); manifest.files[0].url = 'https://example.invalid/wrong-source';
      archive.updateFile('manifest.json', Buffer.from(JSON.stringify(manifest)));
    }
    await writeFile(path.join(raw, snapshotName), archive.toBuffer());
    await assert.rejects(syncDrugData(db, { directory: raw, offline: true, request: noNetwork }), /校驗失敗|來源紀錄無效|檔案清單異常|來源或大小不符/);
    assert.deepEqual(datasetStatus(db), before);
    assert.equal(getTfda(db, 'SYNTHETIC001')?.name, '更新後測試品');
  }
});

test('Missing offline sources fail clearly and preserve the live data', async t => {
  const { db, raw } = await fixture(t), before = datasetStatus(db);
  await assert.rejects(syncDrugData(db, { directory: raw, offline: true, request: noNetwork }), /離線資料不完整/);
  assert.deepEqual(datasetStatus(db), before);
  assert.equal(getTfda(db, 'SYNTHETIC001')?.name, '原始測試品');
});
