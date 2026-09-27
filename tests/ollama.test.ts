import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { ollamaRouter } from '../server/ollama';
import { chatWithAI, getSymptomAdvice, withAIFallback } from '../src/services/gemini';
import { requestJson } from '../src/services/http';
import { listenForFetch } from './http-listener';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};

async function fixture(t: TestContext, fetcher: typeof fetch, timeoutMs = 1000) {
  const app = express();
  app.use(express.json(), ollamaRouter({ fetcher, timeoutMs, baseUrl: 'http://test-ollama.invalid', model: 'test-model' }));
  const server = await listenForFetch(app);
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const { port } = server.address() as { port: number };
  return async (body: unknown = { prompt: 'Synthetic connection test' }, signal?: AbortSignal) => {
    const response = await fetch(`http://127.0.0.1:${port}/`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
    return { status: response.status, body: await response.json() };
  };
}

test('Ollama proxy waits for the full response and preserves the selected model and prompt', async t => {
  const request = await fixture(t, async (url, init) => {
    assert.equal(url, 'http://test-ollama.invalid/api/generate');
    const sent = JSON.parse(String(init?.body));
    assert.equal(sent.model, 'test-model');
    assert.equal(sent.prompt, 'Synthetic connection test');
    assert.equal(sent.stream, false);
    await new Promise(resolve => setTimeout(resolve, 30));
    return json({ response: 'Complete answer', done: true });
  });
  assert.deepEqual(await request(), { status: 200, body: { response: 'Complete answer', done: true } });
});

test('Slow generation reports timeout instead of incorrectly claiming Ollama is offline', async t => {
  const request = await fixture(t, async (_url, init) => new Promise<Response>((_resolve, reject) => {
    init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true });
  }), 10);
  const result = await request();
  assert.equal(result.status, 504);
  assert.equal(result.body.code, 'OLLAMA_TIMEOUT');
  assert.match(result.body.error, /不代表 Ollama 未啟動/);
});

test('Connection refusal, missing models and memory failures have different errors', async t => {
  const offline = await fixture(t, async () => { throw new TypeError('fetch failed'); });
  assert.equal((await offline()).body.code, 'OLLAMA_UNREACHABLE');
  const missing = await fixture(t, async () => json({ error: 'model not found' }, 404));
  assert.equal((await missing()).body.code, 'OLLAMA_MODEL_MISSING');
  const memory = await fixture(t, async () => json({ error: 'model requires more system memory' }, 500));
  assert.match((await memory()).body.error, /記憶體不足/);
});

test('Empty or malformed model output is not treated as a successful answer', async t => {
  const empty = await fixture(t, async () => json({ response: '   ' }));
  assert.equal((await empty()).body.code, 'OLLAMA_EMPTY_RESPONSE');
  const malformed = await fixture(t, async () => new Response('not JSON'));
  assert.equal((await malformed()).status, 502);
});

test('Invalid prompts are rejected before invoking the model', async t => {
  const request = await fixture(t, async () => { assert.fail('Model must not be called'); });
  assert.equal((await request({ prompt: '' })).status, 400);
  assert.equal((await request({ prompt: 'test', system: {} })).status, 400);
});

test('Chat displays the Ollama timeout detail and skips Gemini when no key is configured', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return json({ error: '本機模型未在 300 秒內完成回覆，這不代表 Ollama 未啟動。' }, 504);
  });
  await assert.rejects(chatWithAI([], 'test', undefined, 'ollama'), /Ollama：本機模型未在 300 秒/);
  assert.equal(calls, 1);
});

test('Chat retains both provider failure reasons without exposing Gemini raw errors', async t => {
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request) => {
    if (String(url).startsWith('/api/')) return json({ error: '無法連到 Ollama 背景服務。' }, 503);
    return json({ error: { code: 429, message: 'Quota exceeded, limit: 0, sensitive-diagnostic-value' } }, 429);
  });
  await assert.rejects(chatWithAI([], 'test', 'synthetic-test-key', 'gemini'), error => {
    assert.match((error as Error).message, /Gemini：.*沒有此 Gemini 模型的可用額度/);
    assert.match((error as Error).message, /Ollama：.*背景服務/);
    assert.ok(!(error as Error).message.includes('sensitive-diagnostic-value'));
    return true;
  });
});

test('A browser-to-app connection failure identifies the app backend', async t => {
  t.mock.method(globalThis, 'fetch', async () => { throw new TypeError('Failed to fetch'); });
  await assert.rejects(chatWithAI([], 'test', undefined, 'ollama'), /應用程式後端/);
});

test('Closing the HTTP client interrupts upstream Ollama instead of leaving generation running until timeout', async t => {
  const started = deferred(), stopped = deferred();
  const request = await fixture(t, async (_url, init) => {
    started.resolve();
    return new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener('abort', () => {
      stopped.resolve(); reject(init!.signal!.reason);
    }, { once: true }));
  }, 60_000);
  const controller = new AbortController();
  const response = request({ prompt: 'Cancellation probe' }, controller.signal);
  const rejected = assert.rejects(response, { name: 'AbortError' });
  await started.promise; controller.abort();
  await rejected;
  await Promise.race([stopped.promise, new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error('Ollama request remained running after disconnect')), 1000);
    stopped.promise.finally(() => clearTimeout(timer));
  })]);
});

test('Cancelled calls never invoke fallback, including a late result from a provider ignoring abort', async () => {
  for (const result of ['Late result', '']) {
    const controller = new AbortController(); let fallback = false;
    await assert.rejects(withAIFallback('ollama', {
      ollama: async () => { controller.abort(); return result; },
      gemini: async () => { fallback = true; return 'Must not run'; },
    }, true, controller.signal), { name: 'AbortError' });
    assert.equal(fallback, false);
  }
  await assert.rejects(withAIFallback('gemini', {
    gemini: async () => assert.fail('Aborted before starting'), ollama: async () => assert.fail('Must not fall back'),
  }, true, AbortSignal.abort()), { name: 'AbortError' });
});

test('Chat and symptom requests forward cancellation without disguising it as a connection error', async t => {
  for (const kind of ['chat', 'symptoms']) {
    const controller = new AbortController(); let calls = 0;
    t.mock.method(globalThis, 'fetch', async (_url, init) => {
      calls++; assert.equal(init?.signal, controller.signal);
      controller.abort(); throw controller.signal.reason;
    });
    await assert.rejects(kind === 'chat' ? chatWithAI([], 'Synthetic', undefined, 'ollama', controller.signal)
      : getSymptomAdvice('Synthetic', 'concise', undefined, 'ollama', [], controller.signal), { name: 'AbortError' });
    assert.equal(calls, 1);
    t.mock.restoreAll();
  }
});

test('Gemini SDK receives abort and does not start Ollama after client cancellation', async t => {
  const controller = new AbortController(), started = deferred();
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    calls++; started.resolve();
    assert.ok(init?.signal);
    return new Promise<Response>((_resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }));
  });
  const reply = chatWithAI([], 'Synthetic', 'synthetic-test-key', 'gemini', controller.signal);
  const rejected = assert.rejects(reply, { name: 'AbortError' });
  await started.promise; controller.abort(); await rejected;
  assert.equal(calls, 1);
});

test('Cancellation while reading JSON remains an abort rather than a malformed response error', async t => {
  const controller = new AbortController();
  const response = Response.json({});
  t.mock.method(response, 'json', async () => { controller.abort(); throw controller.signal.reason; });
  t.mock.method(globalThis, 'fetch', async () => response);
  await assert.rejects(requestJson('/test', { signal: controller.signal }), { name: 'AbortError' });
});
