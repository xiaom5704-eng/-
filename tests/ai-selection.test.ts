import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chatWithAI, getSymptomAdvice, generateTitleSummary } from '../src/services/gemini';

const key = 'synthetic-test-key-not-a-credential';
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

test('Selecting Ollama never sends chat, symptoms or titles to Gemini, even with a configured key', async t => {
  const calls: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request) => {
    const address = url instanceof Request ? url.url : String(url); calls.push(address);
    if (address === '/api/ai/ollama') return json({ error: 'Local service is unavailable' }, 503);
    return json({ candidates: [{ content: { role: 'model', parts: [{ text: 'Should not receive this request' }] } }] });
  });
  await assert.rejects(chatWithAI([], 'Synthetic', key, 'ollama'), /Ollama/);
  await assert.rejects(getSymptomAdvice('Synthetic', 'concise', key, 'ollama'), /Ollama/);
  assert.equal(await generateTitleSummary('Synthetic', 'Synthetic', key, 'ollama'), null);
  assert.deepEqual(calls, Array(3).fill('/api/ai/ollama'));
});

test('Selecting Gemini without a key fails clearly rather than using Ollama', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return json({ response: 'Should not receive this request' }); });
  await assert.rejects(chatWithAI([], 'Synthetic', undefined, 'gemini'), /Gemini.*金鑰/);
  assert.equal(calls, 0);
});

test('Empty selected-provider answers do not switch engines or manufacture a successful response', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return json({ response: ' ' }); });
  await assert.rejects(chatWithAI([], 'Synthetic', key, 'ollama'), /沒有產生回答/);
  assert.equal(calls, 1);
});
