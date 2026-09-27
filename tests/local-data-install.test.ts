import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import AdmZip from 'adm-zip';
import { installPublicData } from '../scripts/install-public-data.mjs';

const hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const seedFiles = ['drugs.db', 'vision/index.db', 'vision/models/Xenova/dinov2-small/config.json',
  'vision/models/Xenova/dinov2-small/preprocessor_config.json', 'vision/models/Xenova/dinov2-small/onnx/model_quantized.onnx'];
async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'medsafe-local-install-'));
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('medsafe-local-install-'));
    await rm(root, { recursive: true, force: true });
  });
  const projectRoot = path.join(root, 'project'); await mkdir(projectRoot);
  return { root, projectRoot };
}
function archive(change?: (zip: AdmZip, manifest: { schema: number; preparedAt: string; verify: { path: string; sha256: string }[] }) => void) {
  const zip = new AdmZip();
  const manifest = { schema: 1, preparedAt: '2026-09-24T00:00:00Z', verify: seedFiles.map(file => ({ path: file, sha256: hash(`SYNTHETIC ${file}`) })) };
  seedFiles.forEach(file => zip.addFile(`data/${file}`, Buffer.from(`SYNTHETIC ${file}`)));
  change?.(zip, manifest); zip.addFile('data/manifest.json', Buffer.from(JSON.stringify(manifest)));
  return zip.toBuffer();
}

test('First local install verifies download and every file before publishing data without a key', async t => {
  const { projectRoot } = await fixture(t), bytes = archive(); let downloads = 0;
  const result = await installPublicData({ projectRoot, expectedHash: hash(bytes), download: async (url) => {
    downloads++; assert.match(String(url), /^https:\/\/github.com\/xiaom5704-eng\/\-\/releases\/download\//);
    return new Response(bytes, { status: 200 });
  } });
  assert.equal(downloads, 1); assert.equal(result.verifiedFiles, seedFiles.length);
  assert.deepEqual(await readdir(projectRoot), ['data']);
  assert.equal(await readFile(path.join(projectRoot, 'data/drugs.db'), 'utf8'), 'SYNTHETIC drugs.db');
});

test('Offline ZIP installation does not fetch and preserves the supplied archive', async t => {
  const { root, projectRoot } = await fixture(t), bytes = archive(), archivePath = path.join(root, 'input.zip');
  await writeFile(archivePath, bytes);
  await installPublicData({ projectRoot, archivePath, expectedHash: hash(bytes), download: async () => assert.fail('unexpected network') });
  assert.equal(hash(await readFile(archivePath)), hash(bytes));
});

test('Existing data is never downloaded over or replaced, even when its directory is empty', async t => {
  const { projectRoot } = await fixture(t), data = path.join(projectRoot, 'data'); await mkdir(data);
  const options = { projectRoot, download: async () => assert.fail('must refuse before download') };
  await assert.rejects(installPublicData(options), /data 已存在/);
  await writeFile(path.join(data, 'drugs.db'), 'USER DATA');
  await assert.rejects(installPublicData(options), /data 已存在/);
  assert.equal(await readFile(path.join(data, 'drugs.db'), 'utf8'), 'USER DATA');
});

test('Failed requests, interrupted downloads and incorrect archive hashes leave no half-installed data', async t => {
  const { projectRoot } = await fixture(t);
  for (const download of [async () => new Response('', { status: 503 }), async () => { throw new Error('network interrupted'); }, async () => new Response(archive())]) {
    await assert.rejects(installPublicData({ projectRoot, download, expectedHash: '0'.repeat(64) }));
    assert.deepEqual(await readdir(projectRoot), []);
  }
});

test('Missing required files, wrong file hashes and unsafe manifests are not published', async t => {
  const { projectRoot } = await fixture(t);
  const damaged = [
    archive((zip, manifest) => { zip.deleteFile('data/drugs.db'); manifest.verify = manifest.verify.filter(f => f.path !== 'drugs.db'); }),
    archive((zip) => zip.updateFile('data/drugs.db', Buffer.from('DAMAGED'))),
    archive((_zip, manifest) => { manifest.verify[0].path = '../outside'; }),
    archive((_zip, manifest) => { manifest.verify[1] = manifest.verify[0]; }),
    archive((zip) => zip.addFile('data/extra-private-file.txt', Buffer.from('NOT IN MANIFEST'))),
  ];
  for (const bytes of damaged) {
    await assert.rejects(installPublicData({ projectRoot, expectedHash: hash(bytes), download: async () => new Response(bytes) }));
    assert.deepEqual(await readdir(projectRoot), []);
  }
});

test('Data created by another process during download is preserved at publication', async t => {
  const { projectRoot } = await fixture(t), bytes = archive();
  await assert.rejects(installPublicData({ projectRoot, expectedHash: hash(bytes), download: async () => {
    await mkdir(path.join(projectRoot, 'data')); await writeFile(path.join(projectRoot, 'data/drugs.db'), 'CONCURRENT USER DATA');
    return new Response(bytes);
  } }), /data 已存在/);
  assert.deepEqual(await readdir(projectRoot), ['data']);
  assert.equal(await readFile(path.join(projectRoot, 'data/drugs.db'), 'utf8'), 'CONCURRENT USER DATA');
});

test('Supplement preparation sees only verified staged files and must finish before publication', async t => {
  const { projectRoot } = await fixture(t), bytes = archive(); let called = 0;
  await installPublicData({ projectRoot, expectedHash: hash(bytes), download: async () => new Response(bytes), prepareData: async directory => {
    called++; assert.equal(await readFile(path.join(directory, 'drugs.db'), 'utf8'), 'SYNTHETIC drugs.db');
    await assert.rejects(readFile(path.join(projectRoot, 'data/drugs.db')));
    await writeFile(path.join(directory, 'drugs.db'), 'VERIFIED BASE PLUS SUPPLEMENT');
  } });
  assert.equal(called, 1);
  assert.equal(await readFile(path.join(projectRoot, 'data/drugs.db'), 'utf8'), 'VERIFIED BASE PLUS SUPPLEMENT');
});

test('Failed supplement preparation removes the staged install and never runs on corrupt input', async t => {
  const { projectRoot } = await fixture(t), bytes = archive(); let called = 0;
  const prepareData = async (directory: string) => { called++; await writeFile(path.join(directory, 'drugs.db'), 'PARTIAL'); throw new Error('supplement conflict'); };
  await assert.rejects(installPublicData({ projectRoot, expectedHash: hash(bytes), download: async () => new Response(bytes), prepareData }), /supplement conflict/);
  assert.equal(called, 1); assert.deepEqual(await readdir(projectRoot), []);
  const damaged = archive(zip => zip.updateFile('data/drugs.db', Buffer.from('DAMAGED')));
  await assert.rejects(installPublicData({ projectRoot, expectedHash: hash(damaged), download: async () => new Response(damaged), prepareData }), /校驗失敗/);
  assert.equal(called, 1); assert.deepEqual(await readdir(projectRoot), []);
});
