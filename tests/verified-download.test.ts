import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { downloadVerified, sha256 } from '../scripts/verified-download.mjs';

const bytes = Buffer.from('Synthetic pinned model bytes'), digest = sha256(bytes);
async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'medsafe-download-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('medsafe-download-'));
    await rm(root, { recursive: true, force: true });
  });
  return { root, destination: path.join(root, 'model.bin') };
}
const url = 'https://example.test/pinned/model.bin';
const request = (response: Response) => (async () => response) as typeof fetch;

test('Only a matching pinned file can be reused without network access', async t => {
  const { destination } = await fixture(t);
  await writeFile(destination, bytes);
  const offline = (async () => { throw new Error('Network disabled'); }) as typeof fetch;
  assert.deepEqual(await downloadVerified(url, destination, digest, 100, offline), bytes);
});

test('Missing, empty and nonempty damaged downloads are repaired, leaving no temporary files', async t => {
  const { root, destination } = await fixture(t); let calls = 0;
  const retrieve = (async () => { calls++; return new Response(bytes); }) as typeof fetch;
  for (const damaged of [undefined, '', 'truncated old model']) {
    if (damaged !== undefined) await writeFile(destination, damaged);
    assert.deepEqual(await downloadVerified(url, destination, digest, 100, retrieve), bytes);
    assert.deepEqual(await readFile(destination), bytes);
    assert.deepEqual(await readdir(root), ['model.bin']);
  }
  assert.equal(calls, 3);
});

test('Failed, corrupt, truncated or oversized responses never replace the previous file', async t => {
  const { root, destination } = await fixture(t);
  const old = Buffer.from('existing damaged file'); await writeFile(destination, old);
  const responses = [new Response('down', { status: 503 }), new Response('wrong hash'), new Response(bytes.subarray(0, 5)),
    new Response('too large', { headers: { 'Content-Length': '101' } }), new Response('X'.repeat(101)), new Response('')];
  for (const response of responses) {
    await assert.rejects(downloadVerified(url, destination, digest, 100, request(response)));
    assert.deepEqual(await readFile(destination), old);
    assert.deepEqual(await readdir(root), ['model.bin']);
  }
  const failingStream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1])); controller.error(new Error('Disconnected')); } });
  await assert.rejects(downloadVerified(url, destination, digest, 100, request(new Response(failingStream))), /Disconnected/);
  assert.deepEqual(await readFile(destination), old);
});

test('Invalid expected integrity metadata never initiates a download', async t => {
  const { destination } = await fixture(t); let calls = 0;
  const retrieve = (async () => { calls++; return new Response(bytes); }) as typeof fetch;
  await assert.rejects(downloadVerified(url, destination, 'not a hash', 100, retrieve));
  await assert.rejects(downloadVerified(url, destination, digest, 0, retrieve));
  assert.equal(calls, 0);
});
