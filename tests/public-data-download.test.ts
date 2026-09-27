import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { downloadPublicArchive } from '../scripts/download-public-data.mjs';

const bytes = Buffer.from('Synthetic public archive bytes for bounded resumable download checks.');
const hash = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const digest = hash(bytes);
async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'medsafe-public-chunks-'));
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('medsafe-public-chunks-'));
    await rm(root, { recursive: true, force: true });
  });
  const options = { projectRoot: root, archive: path.join(root, 'archive.zip'), url: 'https://example.test/public.zip',
    expectedBytes: bytes.length, expectedHash: digest, chunkBytes: 16, concurrency: 1, attempts: 1, retryDelayMs: 1 };
  return { root, options, cache: path.join(root, `.data-download-${digest}`) };
}
function range(init?: RequestInit) {
  assert.equal(new Headers(init?.headers).get('accept-encoding'), 'identity');
  const match = /^bytes=(\d+)-(\d+)$/.exec(new Headers(init?.headers).get('range') || ''); assert.ok(match);
  return { start: Number(match[1]), end: Number(match[2]) };
}
function response(start: number, end: number, source = bytes) {
  return new Response(source.subarray(start, end + 1), { status: 206,
    headers: { 'Content-Range': `bytes ${start}-${end}/${bytes.length}`, 'Content-Length': String(end - start + 1) } });
}

test('Parallel ranges stay bounded, assemble in order and fully verified cached chunks work offline', { timeout: 2000 }, async t => {
  const { root, options } = await fixture(t);
  let active = 0, maximum = 0, release!: () => void;
  const ready = new Promise<void>(resolve => { release = resolve; }), requested: number[] = [];
  await downloadPublicArchive({ ...options, concurrency: 3, download: async (_url, init) => {
    const { start, end } = range(init); requested.push(start); active++; maximum = Math.max(maximum, active);
    if (active === 3) release();
    await ready; await delay(start === 0 ? 10 : 1); active--;
    return response(start, end);
  } });
  assert.equal(maximum, 3);
  assert.deepEqual(requested.sort((a, b) => a - b), [0, 16, 32, 48, 64]);
  assert.deepEqual(await readFile(options.archive), bytes);
  const archive = path.join(root, 'offline.zip');
  await downloadPublicArchive({ ...options, archive, download: async () => assert.fail('Complete pinned cache must work offline') });
  assert.deepEqual(await readFile(archive), bytes);
});

test('A corrupt saved chunk is discarded while other verified chunks survive and are not fetched again', async t => {
  const { options, cache } = await fixture(t);
  await assert.rejects(downloadPublicArchive({ ...options, download: async (_url, init) => {
    const { start, end } = range(init);
    return start >= 32 ? new Response('', { status: 503 }) : response(start, end);
  } }));
  const first = (await readdir(cache)).find(name => name.startsWith('0-15-')); assert.ok(first);
  await writeFile(path.join(cache, first), Buffer.alloc(16, 88));
  const requested: number[] = [];
  await downloadPublicArchive({ ...options, download: async (_url, init) => {
    const { start, end } = range(init); requested.push(start); return response(start, end);
  } });
  assert.deepEqual(requested, [0, 32, 48, 64]);
  assert.deepEqual(await readFile(options.archive), bytes);
});

test('Concurrent downloads can share completed chunks without exposing an unfinished write', async t => {
  const { root, options, cache } = await fixture(t);
  const download = async (_url: unknown, init?: RequestInit) => {
    const { start, end } = range(init); await delay(5); return response(start, end);
  };
  const second = path.join(root, 'second.zip');
  await Promise.all([downloadPublicArchive({ ...options, download }), downloadPublicArchive({ ...options, archive: second, download })]);
  assert.deepEqual(await readFile(options.archive), bytes); assert.deepEqual(await readFile(second), bytes);
  assert.equal((await readdir(cache)).length, 5);
  assert.ok((await readdir(cache)).every(file => file.endsWith('.part')));
});

test('Wrong offsets, total size, encoding, lengths, oversized bodies and ignored ranges never enter the cache', async t => {
  const { options, cache } = await fixture(t);
  const responses = [
    new Response(bytes.subarray(0, 16), { status: 206, headers: { 'Content-Range': `bytes 1-16/${bytes.length}` } }),
    new Response(bytes.subarray(0, 16), { status: 206, headers: { 'Content-Range': `bytes 0-15/${bytes.length + 1}` } }),
    new Response(bytes, { status: 200 }),
    new Response(bytes.subarray(0, 16), { status: 206, headers: { 'Content-Range': `bytes 0-15/${bytes.length}`, 'Content-Encoding': 'gzip' } }),
    new Response(bytes.subarray(0, 16), { status: 206, headers: { 'Content-Range': `bytes 0-15/${bytes.length}`, 'Content-Length': '17' } }),
    new Response(bytes.subarray(0, 17), { status: 206, headers: { 'Content-Range': `bytes 0-15/${bytes.length}` } }),
    new Response('', { status: 404 }),
  ];
  for (const value of responses) {
    let calls = 0;
    await assert.rejects(downloadPublicArchive({ ...options, attempts: 3, download: async () => { calls++; return value; } }));
    assert.equal(calls, 1); await assert.rejects(readdir(cache)); await assert.rejects(readFile(options.archive));
  }
});

test('Short bodies retry the same range and a stalled body times out without keeping a partial chunk', async t => {
  const { options, cache } = await fixture(t); let calls = 0, cancelled = false;
  await assert.rejects(downloadPublicArchive({ ...options, attempts: 2, download: async () => {
    calls++; return new Response(bytes.subarray(0, 8), { status: 206, headers: { 'Content-Range': `bytes 0-15/${bytes.length}` } });
  } }));
  assert.equal(calls, 2); await assert.rejects(readdir(cache));
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    await assert.rejects(downloadPublicArchive({ ...options, requestTimeoutMs: 20, download: async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(bytes.subarray(0, 8)); }, cancel() { cancelled = true; },
    }), { status: 206, headers: { 'Content-Range': `bytes 0-15/${bytes.length}` } }) }));
  } finally { clearTimeout(keepAlive); }
  assert.equal(cancelled, true); await assert.rejects(readdir(cache));
});

test('Cancellation preserves complete chunks, cancels pending bodies and does not automatically retry', async t => {
  const { options, cache } = await fixture(t), controller = new AbortController(); let calls = 0, cancelled = false;
  const timers: ReturnType<typeof setTimeout>[] = [];
  t.after(() => timers.forEach(clearTimeout));
  await assert.rejects(downloadPublicArchive({ ...options, signal: controller.signal, attempts: 3, download: async (_url, init) => {
    const { start, end } = range(init); calls++;
    if (start === 0) return response(start, end);
    timers.push(setTimeout(() => controller.abort(new Error('User cancelled')), 10));
    return new Response(new ReadableStream({ start() {}, cancel() { cancelled = true; } }),
      { status: 206, headers: { 'Content-Range': `bytes ${start}-${end}/${bytes.length}` } });
  } }), /User cancelled/);
  assert.equal(calls, 2); assert.equal(cancelled, true); assert.equal((await readdir(cache)).length, 1);
  await assert.rejects(readFile(options.archive));
});

test('Individually valid chunks with the wrong whole-file hash are rejected and removed for the next attempt', async t => {
  const { options, cache } = await fixture(t), changed = Buffer.from(bytes); changed[0] ^= 1;
  await assert.rejects(downloadPublicArchive({ ...options, download: async (_url, init) => {
    const { start, end } = range(init); return response(start, end, changed);
  } }), /SHA-256/);
  await assert.rejects(readdir(cache));
  await assert.rejects(readFile(options.archive));
});

test('Cache junctions and fake chunk directories do not write to or remove external files', async t => {
  const { root, options, cache } = await fixture(t), outside = path.join(root, 'outside');
  await mkdir(outside); await writeFile(path.join(outside, 'keep.txt'), 'USER FILE');
  await symlink(outside, cache, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(downloadPublicArchive({ ...options, download: async () => assert.fail('Unsafe cache must not fetch') }), /一般資料夾/);
  assert.equal(await readFile(path.join(outside, 'keep.txt'), 'utf8'), 'USER FILE');
  await rm(cache); await mkdir(cache);
  await mkdir(path.join(cache, `0-15-${hash(bytes.subarray(0, 16))}.part`));
  await assert.rejects(downloadPublicArchive({ ...options, download: async () => assert.fail('Unsafe chunk must not fetch') }), /不合法/);
  assert.equal(await readFile(path.join(outside, 'keep.txt'), 'utf8'), 'USER FILE');
});
