import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { listenForFetch } from './http-listener';
import express from 'express';
import sharp from 'sharp';
import { parsePillObservation } from '../shared/pill-observation';
import { observePillAppearance, pillObserverRouter } from '../server/vision/observer';

const modelResult = { kind: 'pill', shape: '圓形', color: '白', imprints: ['FC 10'] };
const options = { baseUrl: 'http://127.0.0.1:11434', model: 'synthetic-vision' };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const output = (value = modelResult) => json({ message: { content: JSON.stringify(value) }, done_reason: 'stop' });
const signal = () => new AbortController().signal;
async function photo() {
  const bytes = Buffer.alloc(64 * 64 * 3);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31) % 256;
  return sharp(bytes, { raw: { width: 64, height: 64, channels: 3 } }).png().toBuffer();
}

test('Pill observations retain literal markings, remove score lines and never supply medication identity', () => {
  const result = parsePillObservation({ ...modelResult, color: '不確定', imprints: ['ＦＣ １０', '-'] });
  assert.deepEqual(result, { name: '', strength: '', dosageForm: '', appearance: { shape: '圓形', color: '', imprints: ['FC 10'] } });
  assert.deepEqual(parsePillObservation({ ...modelResult, imprints: ['O1', '01'] }).appearance.imprints, ['O1', '01']);
  for (const value of [null, [], {}, 'pill', { ...modelResult, name: 'guessed drug' }, { ...modelResult, color: 'pink' },
    { ...modelResult, imprints: ['a', 'b', 'c'] }, { ...modelResult, imprints: [5] }, { ...modelResult, imprints: ['a'.repeat(81)] }]) {
    assert.throws(() => parsePillObservation(value), /有效外觀資料/);
  }
  for (const kind of ['package', 'other', 'unclear']) assert.throws(() => parsePillObservation({ ...modelResult, kind }), /未能確認/);
  assert.throws(() => parsePillObservation({ ...modelResult, color: '不確定', imprints: ['-'] }), /特徵仍不足/);
});

test('Observer transmits only re-encoded photos and a constrained task to an installed local vision model', async () => {
  const calls: { url: string; init: RequestInit; body: any }[] = [];
  const fetcher = (async (url, init) => {
    const call = { url: String(url), init: init!, body: JSON.parse(String(init?.body)) }; calls.push(call);
    return calls.length === 1 ? json({ capabilities: ['completion', 'vision'] }) : output();
  }) as typeof fetch;
  const result = await observePillAppearance([await photo()], signal(), { ...options, fetcher });
  assert.equal(result.model, options.model); assert.ok(Date.parse(result.checkedAt));
  assert.equal(result.observation.name, ''); assert.deepEqual(result.observation.appearance.imprints, ['FC 10']);
  assert.deepEqual(calls.map(call => new URL(call.url).pathname), ['/api/show', '/api/chat']);
  assert.deepEqual(calls[0].body, { model: options.model });
  const request = calls[1].body;
  assert.equal(request.format.additionalProperties, false); assert.equal(request.think, false);
  assert.equal(request.messages[0].images.length, 1);
  const metadata = await sharp(Buffer.from(request.messages[0].images[0], 'base64')).metadata();
  assert.equal(metadata.format, 'jpeg'); assert.equal(metadata.exif, undefined);
  assert.ok(calls.every(call => call.init.redirect === 'error'));
});

test('Remote/cloud or invalid destinations cannot receive photos or trigger automatic fallback', async () => {
  let calls = 0; const fetcher = (async () => { calls++; return output(); }) as typeof fetch;
  for (const baseUrl of ['https://example.test', 'http://127.0.0.1.example.test', 'http://user:secret@localhost', 'file:///tmp/model', 'not a url']) {
    await assert.rejects(observePillAppearance([await photo()], signal(), { ...options, baseUrl, fetcher }), /本機/);
  }
  await assert.rejects(observePillAppearance([await photo()], signal(), { ...options, model: 'vision:cloud', fetcher }), /本機/);
  assert.equal(calls, 0);
});

test('Missing, remote or text-only models are rejected before any image request', async () => {
  for (const value of [null, { capabilities: ['completion'] }, { capabilities: ['vision'], remote_host: 'https://example.test' }, { capabilities: ['vision'], remote_model: 'cloud-model' }]) {
    const calls: string[] = [];
    const fetcher = (async (url) => { calls.push(String(url)); return value ? json(value) : json({}, 404); }) as typeof fetch;
    await assert.rejects(observePillAppearance([await photo()], signal(), { ...options, fetcher }), /模型/);
    assert.deepEqual(calls.map(url => new URL(url).pathname), ['/api/show']);
  }
});

test('Blank, corrupt, tiny and multi-frame photos are rejected before network calls', async () => {
  let calls = 0; const fetcher = (async () => { calls++; return output(); }) as typeof fetch;
  const blank = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#fff' } }).png().toBuffer();
  const tiny = await sharp(await photo()).resize(16, 16).png().toBuffer();
  const animated = await sharp(Buffer.alloc(64 * 128 * 3, 50), { raw: { width: 64, height: 128, channels: 3, pageHeight: 64 } }).webp({ loop: 0, delay: [100, 100] }).toBuffer();
  for (const image of [blank, Buffer.from('broken file'), tiny, animated]) await assert.rejects(observePillAppearance([image], signal(), { ...options, fetcher }), /照片|圖片|細節/);
  assert.equal(calls, 0);
});

test('Partial or malformed model output fails with no guessed identity', async () => {
  for (const data of [{ message: { content: 'not json' } }, { message: { content: JSON.stringify(modelResult) }, done_reason: 'length' },
    { message: { content: JSON.stringify({ ...modelResult, drug: 'invented' }) } }, { message: { content: 'x'.repeat(3001) } }]) {
    const fetcher = (async (url) => String(url).endsWith('/show') ? json({ capabilities: ['vision'] }) : json(data)) as typeof fetch;
    await assert.rejects(observePillAppearance([await photo()], signal(), { ...options, fetcher }), /外觀/);
  }
});

test('Offline and timed-out Ollama requests give actionable errors; pre-cancelled tasks send nothing', async () => {
  const images = [await photo()];
  await assert.rejects(observePillAppearance(images, signal(), { ...options, fetcher: (async () => { throw new TypeError('fetch failed'); }) as typeof fetch }), /請啟動背景服務/);
  const fetcher = ((_url: any, init: any) => new Promise<Response>((_resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('test timeout')), 2000);
    const cancel = () => { clearTimeout(timer); reject(init.signal.reason); };
    if (init.signal.aborted) cancel(); else init.signal.addEventListener('abort', cancel, { once: true });
  })) as typeof fetch;
  await assert.rejects(observePillAppearance(images, signal(), { ...options, timeoutMs: 30, fetcher }), /逾時/);
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(observePillAppearance(images, cancelled.signal, { ...options, fetcher: (async () => { assert.fail('Must not fetch'); }) as typeof fetch }), { name: 'AbortError' });
});

test('HTTP observer shares the image queue, releases it on cancellation and can recover', async () => {
  const queue = { busy: false };
  let chatCalls = 0, cancelled = false;
  const fetcher = (async (url, init) => {
    if (String(url).endsWith('/show')) return json({ capabilities: ['vision'] });
    chatCalls++;
    if (chatCalls > 1) return output();
    return new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener('abort', () => { cancelled = true; reject(init!.signal!.reason); }, { once: true }));
  }) as typeof fetch;
  const app = express(); app.use(express.json()); app.use(pillObserverRouter(queue, { ...options, fetcher }));
  const server = await listenForFetch(app);
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  const body = JSON.stringify({ images: [`data:image/png;base64,${(await photo()).toString('base64')}`] });
  const post = (signal?: AbortSignal, content = body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: content, signal });
  const waitFor = async (condition: () => boolean) => {
    const deadline = Date.now() + 2000;
    while (!condition()) { assert.ok(Date.now() < deadline, 'request must settle'); await new Promise(resolve => setTimeout(resolve, 10)); }
  };
  try {
    assert.equal((await post(undefined, '{}')).status, 400); assert.equal(queue.busy, false);
    const controller = new AbortController(), first = post(controller.signal);
    const rejected = assert.rejects(first, { name: 'AbortError' });
    await waitFor(() => chatCalls === 1);
    assert.equal((await post()).status, 429);
    controller.abort(); await rejected; await waitFor(() => cancelled && !queue.busy);
    const response = await post(); assert.equal(response.status, 200);
    const result = await response.json(); assert.equal(result.observation.name, ''); assert.equal(result.candidates, undefined);
    assert.equal(queue.busy, false);
  } finally { server.closeAllConnections(); server.close(); await once(server, 'close'); }
});
