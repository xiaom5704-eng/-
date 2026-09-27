import test from 'node:test';
import assert from 'node:assert/strict';
import { readPendingReplies, writePendingReplies, savePendingReply, type PendingReply } from '../src/services/pending-replies';
const reply: PendingReply = { requestId: 'request-1', sessionId: 'session-1', userContent: '30 歲，合成問題', assistantContent: '**合成回答**', question: '合成問題', answer: '合成回答', kind: 'chat' };
function storage() {
  const values = new Map<string, string>();
  return { values, getItem: (key: string) => values.get(key) || null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
}
test('Pending reply recovery preserves the original question, age, answer and request identity until acknowledged', () => {
  const cache = storage(), getStorage = () => cache;
  assert.equal(writePendingReplies(getStorage, { [reply.sessionId]: reply }), true);
  assert.deepEqual(readPendingReplies(getStorage), { [reply.sessionId]: reply });
  assert.equal(writePendingReplies(getStorage, {}), true);
  assert.deepEqual(readPendingReplies(getStorage), {}); assert.equal(cache.values.size, 0);
});
test('Unavailable, full or corrupt browser storage does not crash the conversation', () => {
  const cache = storage(); cache.values.set('medsafe.pending-replies.v1', 'not json');
  assert.deepEqual(readPendingReplies(() => cache), {});
  cache.values.set('medsafe.pending-replies.v1', JSON.stringify([{}, { ...reply, kind: 'wrong' }, reply]));
  assert.deepEqual(readPendingReplies(() => cache), { [reply.sessionId]: reply });
  const unavailable = () => { throw new Error('storage unavailable'); };
  assert.deepEqual(readPendingReplies(unavailable), {}); assert.equal(writePendingReplies(unavailable, {}), false);
  const full = { ...cache, setItem: () => { throw new Error('quota full'); } };
  assert.equal(writePendingReplies(() => full, { [reply.sessionId]: reply }), false);
});
test('Retry sends identical saved content only to the original session and never regenerates a reply', async t => {
  const calls: any[] = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json' } });
  });
  await savePendingReply(reply); await savePendingReply(reply);
  assert.deepEqual(calls, Array(2).fill({ url: '/api/sessions/session-1/exchange', body: { requestId: reply.requestId, userContent: reply.userContent, assistantContent: reply.assistantContent } }));
});

test('Recovery retains an existing question ID so retrying persistence does not duplicate legacy questions', async t => {
  const linked = { ...reply, requestId: 'reply-17', userMessageId: 17 };
  const cache = storage(); writePendingReplies(() => cache, { [reply.sessionId]: linked });
  const recovered = readPendingReplies(() => cache)[reply.sessionId];
  assert.deepEqual(recovered, linked);
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    assert.equal(JSON.parse(options.body).userMessageId, 17);
    return Response.json({ success: true });
  });
  await savePendingReply(recovered);
  cache.values.set('medsafe.pending-replies.v1', JSON.stringify([{ ...linked, userMessageId: '17' }]));
  assert.deepEqual(readPendingReplies(() => cache), {});
});

test('Medication report recovery preserves the original session, source text and pending session creation', async t => {
  const report: PendingReply = { ...reply, kind: 'medication', assistantContent: '# 1 個月\n來源：https://example.test/original\n原查詢時間', newSessionTitle: '藥物資料查詢' };
  const cache = storage(); writePendingReplies(() => cache, { [report.sessionId]: report });
  const recovered = readPendingReplies(() => cache)[report.sessionId]; assert.deepEqual(recovered, report);
  const calls: any[] = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) }); return Response.json({ messages: [] });
  });
  await savePendingReply(recovered); await savePendingReply(recovered);
  assert.deepEqual(calls, Array(2).fill({ url: '/api/sessions/session-1/medication-report', body: {
    requestId: report.requestId, content: report.assistantContent, newSessionTitle: '藥物資料查詢',
  } }));
});

test('Corrupt pending report metadata cannot create a session or discard other recoverable answers', () => {
  const cache = storage();
  cache.values.set('medsafe.pending-replies.v1', JSON.stringify([
    { ...reply, newSessionTitle: 'Not allowed for a chat' }, { ...reply, kind: 'medication', newSessionTitle: '' },
    { ...reply, kind: 'medication', newSessionTitle: [] }, reply,
  ]));
  assert.deepEqual(readPendingReplies(() => cache), { [reply.sessionId]: reply });
});
