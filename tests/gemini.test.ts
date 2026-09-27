import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GEMINI_MODEL, geminiErrorMessage } from '../src/services/gemini-client';
import { testGeminiKey, chatWithAI, getSymptomAdvice, generateTitleSummary } from '../src/services/gemini';
import { extractMedicationNames } from '../src/services/medication-ai';

const syntheticKey = 'synthetic-test-key-not-a-credential';
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

test('Key validation, OCR and text use the same Gemini model', async t => {
  const urls: string[] = [];
  const medications = [{ name: 'Test medicine', strength: '1 mg', dosageForm: 'tablet' }];
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request) => {
    urls.push(url instanceof Request ? url.url : String(url));
    const text = urls.length === 2 ? JSON.stringify({ medications }) : '測試回覆';
    return json({ candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }] });
  });
  assert.equal(await testGeminiKey(syntheticKey), true);
  assert.deepEqual(await extractMedicationNames(['data:image/png;base64,AA=='], syntheticKey), medications);
  assert.equal(await chatWithAI([], 'test', syntheticKey, 'gemini'), '測試回覆');
  assert.equal(await getSymptomAdvice('test', 'concise', syntheticKey, 'gemini'), '測試回覆');
  assert.equal(await generateTitleSummary('test', 'test', syntheticKey, 'gemini'), '測試回覆');
  assert.equal(urls.length, 5);
  assert.ok(urls.every(url => url.includes(`/models/${GEMINI_MODEL}:generateContent`)));
});

test('A successful key request with no text is valid even when the output budget is exhausted', async t => {
  t.mock.method(globalThis, 'fetch', async () => json({ candidates: [{ content: { role: 'model', parts: [] }, finishReason: 'MAX_TOKENS' }] }));
  assert.equal(await testGeminiKey(syntheticKey), true);
});

test('Zero quota is reported distinctly from a bad key in both key testing and OCR', async t => {
  t.mock.method(globalThis, 'fetch', async () => json({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded, limit: 0, model: example' } }, 429));
  await assert.rejects(testGeminiKey(syntheticKey), /沒有此 Gemini 模型的可用額度/);
  await assert.rejects(extractMedicationNames(['data:image/png;base64,AA=='], syntheticKey), /沒有此 Gemini 模型的可用額度/);
});

test('Gemini error messages are readable and do not expose raw provider errors or credentials', () => {
  assert.match(geminiErrorMessage({ status: 429, message: 'Quota exceeded, retry later' }), /速率限制/);
  assert.match(geminiErrorMessage({ status: 400, message: 'API key not valid' }), /金鑰無效/);
  assert.match(geminiErrorMessage({ status: 403, message: 'denied' }), /權限/);
  assert.match(geminiErrorMessage({ status: 404 }), /模型無法使用/);
  assert.match(geminiErrorMessage({ status: 503 }), /服務暫時/);
  const message = geminiErrorMessage(new Error(`Unknown error with credential ${syntheticKey}`));
  assert.ok(!message.includes(syntheticKey));
  assert.ok(!message.includes('Unknown error'));
});

test('Closing key validation aborts the SDK request and cannot report a late success', async t => {
  const controller = new AbortController();
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    assert.ok(init?.signal); controller.abort();
    return json({ candidates: [{ content: { role: 'model', parts: [{ text: 'Late OK' }] } }] });
  });
  await assert.rejects(testGeminiKey(syntheticKey, controller.signal), { name: 'AbortError' });
});
