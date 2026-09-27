import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import express from 'express';
import { openSessionDatabase, sessionRouter } from '../server/sessions';
import { requestJson } from '../src/services/http';
import { withSelectedAI } from '../src/services/gemini';
import { listenForFetch } from './http-listener';

async function fixture(t: TestContext) {
  const db = openSessionDatabase(':memory:');
  const app = express();
  app.use(express.json(), sessionRouter(db));
  app.use((_error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(500).json({ error: 'test failure' }));
  const server = await listenForFetch(app);
  const address = server.address() as { port: number };
  t.after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); db.close(); });
  const request = async (path: string, method = 'GET', body?: unknown) => {
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
      method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  await request('/sessions', 'POST', { id: 'a', title: '新對話' });
  return { db, request };
}

test('A delayed automatic title cannot overwrite a manual rename', async t => {
  const { request } = await fixture(t);
  await request('/sessions/a', 'PATCH', { title: '第一次自動標題', is_manual_title: 0 });
  assert.equal((await request('/sessions')).body[0].title, '第一次自動標題');
  await request('/sessions/a', 'PATCH', { title: '使用者手動命名', is_manual_title: 1 });
  await request('/sessions/a', 'PATCH', { title: '較晚回來的 AI 標題', is_manual_title: 0 });
  await request('/sessions/a', 'PATCH', { is_pinned: true });
  const session = (await request('/sessions')).body[0];
  assert.equal(session.title, '使用者手動命名');
  assert.equal(session.is_manual_title, 1);
  assert.equal(session.is_pinned, 1);
});

test('Deleted sessions reject late AI messages and titles without orphan records', async t => {
  const { db, request } = await fixture(t);
  await request('/sessions/a', 'DELETE');
  assert.equal((await request('/messages', 'POST', { session_id: 'a', role: 'assistant', content: '遲到的回應' })).status, 404);
  assert.equal((await request('/sessions/a', 'PATCH', { title: '遲到的標題', is_manual_title: 0 })).status, 404);
  assert.equal((await request('/sessions/a/medication-report', 'POST', { content: '測試報告' })).status, 404);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM messages').get().count, 0);
});

test('Session inputs fail with JSON errors and preserve existing data', async t => {
  const { request } = await fixture(t);
  assert.equal((await request('/sessions', 'POST', { id: 'a', title: '重複' })).status, 409);
  assert.equal((await request('/sessions', 'POST', { id: [], title: '' })).status, 400);
  assert.equal((await request('/sessions/a', 'PATCH', { title: ' ' })).status, 400);
  assert.equal((await request('/messages', 'POST', { session_id: 'a', role: 'invalid', content: '測試' })).status, 400);
  assert.equal((await request('/sessions')).body[0].title, '新對話');
  assert.deepEqual((await request('/messages/a')).body, []);
});

test('A first question creates its session atomically and an uncertain-response retry reuses the same row', async t => {
  const { request } = await fixture(t);
  const body = { session_id: 'first', role: 'user', content: '諮詢對象年齡：30 歲\n人工問題', client_id: 'attempt:user', newSessionTitle: '新對話測試' };
  const first = await request('/messages', 'POST', body);
  assert.equal(first.status, 200);
  assert.deepEqual((await request('/messages', 'POST', body)).body, first.body);
  assert.equal((await request('/messages/first')).body.length, 1);
  await request('/sessions/first', 'PATCH', { title: '手動標題', is_manual_title: 1 });
  assert.deepEqual((await request('/messages', 'POST', body)).body, first.body);
  assert.equal((await request('/sessions')).body.find((s: { id: string }) => s.id === 'first').title, '手動標題');
  assert.equal((await request('/messages', 'POST', { ...body, content: '不同年齡或內容' })).status, 409);
  assert.equal((await request('/messages', 'POST', { ...body, client_id: 'another:user' })).status, 409);
  assert.equal((await request('/messages/first')).body.length, 1);
  assert.equal((await request('/sessions/first/exchange', 'POST', { requestId: 'attempt', userMessageId: first.body.id,
    userContent: body.content, assistantContent: '人工回答' })).status, 200);
  assert.equal((await request('/messages/first')).body.length, 2);
});

test('Failed first-question writes roll back the session and cannot recreate deleted conversations', async t => {
  const { db, request } = await fixture(t);
  const body = { session_id: 'new', role: 'user', content: '人工問題', client_id: 'attempt:user', newSessionTitle: '新對話' };
  db.exec("CREATE TRIGGER reject_first BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT, 'synthetic write failure'); END;");
  assert.equal((await request('/messages', 'POST', body)).status, 500);
  assert.equal((await request('/messages/new')).status, 404);
  assert.equal((await request('/sessions')).body.length, 1);
  db.exec('DROP TRIGGER reject_first');
  assert.equal((await request('/messages', 'POST', body)).status, 200);
  await request('/sessions/new', 'DELETE');
  assert.equal((await request('/messages', 'POST', body)).status, 410);
  assert.equal((await request('/messages/new')).status, 404);
  for (const change of [{ client_id: undefined }, { newSessionTitle: '' }, { role: 'assistant' }])
    assert.equal((await request('/messages', 'POST', { ...body, session_id: 'invalid', ...change })).status, 400);
  assert.equal((await request('/messages/invalid')).status, 404);
});

test('Report messages retain stable order, and session deletion removes both', async t => {
  const { request } = await fixture(t);
  const saved = await request('/sessions/a/medication-report', 'POST', { content: '純測試報告' });
  assert.equal(saved.status, 200);
  const messages = (await request('/messages/a')).body;
  assert.deepEqual(messages.map((item: { role: string }) => item.role), ['user', 'assistant']);
  assert.equal(messages[1].content, '純測試報告');
  assert.equal(messages[1].id, saved.body.messages[1].id);
  await request('/sessions/a', 'DELETE');
  assert.deepEqual((await request('/sessions')).body, []);
  assert.equal((await request('/messages/a')).status, 404);
});

test('A report transaction rolls back the user message if the answer cannot be saved', async t => {
  const { db, request } = await fixture(t);
  db.exec("CREATE TRIGGER reject_answer BEFORE INSERT ON messages WHEN NEW.role = 'assistant' BEGIN SELECT RAISE(ABORT, 'test failure'); END;");
  assert.equal((await request('/sessions/a/medication-report', 'POST', { content: '測試' })).status, 500);
  assert.deepEqual((await request('/messages/a')).body, []);
});

test('Medication report retries preserve the original pair after an uncertain acknowledgement', async t => {
  const { request } = await fixture(t);
  const body = { requestId: 'report-1', content: '## 1 個月\nOriginal report with sources' };
  const first = await request('/sessions/a/medication-report', 'POST', body);
  const retry = await request('/sessions/a/medication-report', 'POST', body);
  assert.equal(first.status, 200); assert.deepEqual(retry.body, first.body);
  assert.equal((await request('/messages/a')).body.length, 2);
  assert.equal((await request('/sessions/a/medication-report', 'POST', { ...body, content: 'Changed age or results' })).status, 409);
  assert.equal((await request('/messages/a')).body.length, 2);
});

test('A first report creates the session and message pair atomically, without orphan sessions on failure', async t => {
  const { db, request } = await fixture(t);
  const body = { requestId: 'new-report', content: 'Original report', newSessionTitle: '藥物資料查詢' };
  db.exec("CREATE TRIGGER fail_report BEFORE INSERT ON messages WHEN NEW.role='assistant' BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END;");
  assert.equal((await request('/sessions/new/medication-report', 'POST', body)).status, 500);
  assert.equal((await request('/sessions')).body.length, 1);
  db.exec('DROP TRIGGER fail_report');
  const first = await request('/sessions/new/medication-report', 'POST', body);
  assert.equal(first.status, 200);
  assert.deepEqual((await request('/sessions/new/medication-report', 'POST', body)).body, first.body);
  assert.equal((await request('/sessions')).body.length, 2);
  assert.equal((await request('/messages/new')).body.length, 2);
});

test('Concurrent report retries do not duplicate messages or overwrite manually renamed sessions', async t => {
  const { request } = await fixture(t);
  const body = { requestId: 'concurrent', content: 'Report source text', newSessionTitle: 'Original draft title' };
  const results = await Promise.all(Array.from({ length: 5 }, () => request('/sessions/a/medication-report', 'POST', body)));
  assert.ok(results.every(result => result.status === 200));
  assert.ok(results.every(result => JSON.stringify(result.body) === JSON.stringify(results[0].body)));
  assert.equal((await request('/messages/a')).body.length, 2);
  await request('/sessions/a', 'PATCH', { title: 'My own title' });
  assert.equal((await request('/sessions/a/medication-report', 'POST', body)).status, 200);
  assert.equal((await request('/sessions')).body[0].title, 'My own title');
  for (const changed of [{ ...body, requestId: '' }, { ...body, requestId: null }, { content: 'Report', newSessionTitle: 'Needs an ID' }])
    assert.equal((await request('/sessions/a/medication-report', 'POST', changed)).status, 400);
});

test('Deleted sessions cannot be recreated by delayed first-report requests, including after reopening', async t => {
  const { request } = await fixture(t);
  await request('/sessions/draft', 'DELETE');
  const body = { requestId: 'late-report', content: 'Synthetic report', newSessionTitle: 'Old draft' };
  assert.equal((await request('/sessions/draft/medication-report', 'POST', body)).status, 410);
  assert.equal((await request('/sessions', 'POST', { id: 'draft', title: 'Old draft' })).status, 410);
  assert.equal((await request('/sessions')).body.length, 1);
  assert.equal((await request('/messages/draft')).status, 404);
  const file = join(tmpdir(), `medsafe-deleted-${randomUUID()}.db`);
  t.after(() => unlinkSync(file));
  const first = openSessionDatabase(file);
  first.prepare('INSERT INTO deleted_sessions(id) VALUES (?)').run('deleted'); first.close();
  const reopened = openSessionDatabase(file);
  try { assert.deepEqual(reopened.prepare('SELECT * FROM deleted_sessions').all(), [{ id: 'deleted' }]); }
  finally { reopened.close(); }
});

test('Old chat databases migrate without discarding conversations', () => {
  const file = join(tmpdir(), `medsafe-migration-${randomUUID()}.db`);
  const legacy = new Database(file);
  legacy.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP); INSERT INTO sessions (id, title) VALUES ('legacy', '保留舊對話');");
  legacy.close();
  const migrated = openSessionDatabase(file);
  try {
    const row = migrated.prepare('SELECT * FROM sessions').get();
    assert.equal(row.title, '保留舊對話');
    assert.equal(row.is_pinned, 0);
    assert.equal(row.is_manual_title, 0);
  } finally { migrated.close(); unlinkSync(file); }
});

test('Retrying a saved exchange after an uncertain response returns the same two messages', async t => {
  const { request } = await fixture(t);
  const body = { requestId: 'turn-1', userContent: 'Test question', assistantContent: 'Saved answer' };
  const user = await request('/messages', 'POST', { session_id: 'a', role: 'user', content: body.userContent, client_id: 'turn-1:user' });
  const first = await request('/sessions/a/exchange', 'POST', body);
  const again = await request('/sessions/a/exchange', 'POST', body);
  assert.equal(first.status, 200); assert.deepEqual(first.body, again.body);
  assert.equal(first.body.ids[0], user.body.id);
  assert.deepEqual((await request('/messages/a')).body.map((message: any) => [message.role, message.content]), [['user', body.userContent], ['assistant', body.assistantContent]]);
  // Conflicting reuse never silently overwrites an existing question/answer.
  assert.equal((await request('/sessions/a/exchange', 'POST', { ...body, assistantContent: 'Different answer' })).status, 409);
  assert.equal((await request('/messages', 'POST', { session_id: 'a', role: 'assistant', content: 'Wrong role', client_id: 'turn-1:user' })).status, 409);
  assert.equal((await request('/messages/a')).body.length, 2);
});

test('Symptom exchanges roll back completely on write failure and remain retryable', async t => {
  const { db, request } = await fixture(t);
  const body = { requestId: 'symptoms-1', userContent: '[症狀諮詢]\nTest only', assistantContent: 'Synthetic answer' };
  db.exec("CREATE TRIGGER reject_exchange BEFORE INSERT ON messages WHEN NEW.role='assistant' BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END;");
  assert.equal((await request('/sessions/a/exchange', 'POST', body)).status, 500);
  assert.deepEqual((await request('/messages/a')).body, []);
  db.exec('DROP TRIGGER reject_exchange');
  assert.equal((await request('/sessions/a/exchange', 'POST', body)).status, 200);
  assert.equal((await request('/messages/a')).body.length, 2);
});

test('Retrying a legacy unanswered question preserves its ID and stores only one answer after lost acknowledgements', async t => {
  const { db, request } = await fixture(t);
  const question = await request('/messages', 'POST', { session_id: 'a', role: 'user', content: '30 歲，original' });
  const userMessageId = question.body.id;
  const body = { requestId: `reply-${userMessageId}`, userMessageId, userContent: '30 歲，original', assistantContent: 'Synthetic answer' };
  for (let pass = 0; pass < 2; pass++) {
    const saved = await request('/sessions/a/exchange', 'POST', body);
    assert.equal(saved.status, 200); assert.equal(saved.body.ids[0], userMessageId);
  }
  const rows = (await request('/messages/a')).body;
  assert.equal(rows.length, 2); assert.equal(rows[0].client_id, null);
  assert.equal(rows[1].client_id, `reply-${userMessageId}:assistant`);
  assert.equal((await request('/sessions/a/exchange', 'POST', { ...body, assistantContent: 'Different result' })).status, 409);
  assert.equal((db.prepare('SELECT count(*) AS n FROM messages').get() as any).n, 2);
});

test('Existing-question replies reject wrong sessions, altered questions, IDs and stale histories', async t => {
  const { request } = await fixture(t);
  const saved = await request('/messages', 'POST', { session_id: 'a', role: 'user', content: 'Original', client_id: 'turn:user' });
  const body = { requestId: 'turn', userMessageId: saved.body.id, userContent: 'Original', assistantContent: 'Answer' };
  await request('/sessions', 'POST', { id: 'b', title: 'Other' });
  assert.equal((await request('/sessions/b/exchange', 'POST', body)).status, 409);
  for (const changed of [{ ...body, userContent: 'Wrong age' }, { ...body, requestId: 'wrong' }, { ...body, userMessageId: 999 }])
    assert.equal((await request('/sessions/a/exchange', 'POST', changed)).status, 409);
  assert.equal((await request('/sessions/a/exchange', 'POST', { ...body, userMessageId: '1' })).status, 400);
  assert.equal((await request('/messages/a')).body.length, 1);
  await request('/messages', 'POST', { session_id: 'a', role: 'user', content: 'Another tab sent a new question' });
  assert.equal((await request('/sessions/a/exchange', 'POST', body)).status, 409);
  assert.equal((await request('/messages/a')).body.length, 2);
});

test('New identified questions retain idempotent saving when linked by their persisted row ID', async t => {
  const { request } = await fixture(t);
  const saved = await request('/messages', 'POST', { session_id: 'a', role: 'user', content: 'Original', client_id: 'turn:user' });
  const body = { requestId: 'turn', userMessageId: saved.body.id, userContent: 'Original', assistantContent: 'Answer' };
  const first = await request('/sessions/a/exchange', 'POST', body);
  assert.equal(first.status, 200);
  assert.deepEqual((await request('/sessions/a/exchange', 'POST', body)).body, first.body);
  assert.equal((await request('/messages/a')).body.length, 2);
});

test('Exchange IDs are session-scoped; deleted sessions and invalid replies cannot create data', async t => {
  const { request } = await fixture(t);
  const body = { requestId: 'same-id', userContent: 'Question', assistantContent: 'Answer' };
  await request('/sessions', 'POST', { id: 'b', title: 'Other person' });
  for (const id of ['a', 'b']) assert.equal((await request(`/sessions/${id}/exchange`, 'POST', body)).status, 200);
  assert.equal((await request('/messages/b')).body.length, 2);
  for (const value of [{}, { ...body, requestId: 2 }, { ...body, assistantContent: '' }]) assert.equal((await request('/sessions/a/exchange', 'POST', value)).status, 400);
  await request('/sessions/a', 'DELETE');
  assert.equal((await request('/sessions/a/exchange', 'POST', body)).status, 404);
  assert.equal((await request('/messages/b')).body.length, 2);
});

test('Message identity migration and exchange retries survive database reopening', async t => {
  const file = join(tmpdir(), `medsafe-exchange-${randomUUID()}.db`);
  t.after(() => unlinkSync(file));
  const old = new Database(file);
  old.exec("CREATE TABLE sessions(id TEXT PRIMARY KEY,title TEXT,created_at DATETIME DEFAULT CURRENT_TIMESTAMP); INSERT INTO sessions(id,title) VALUES('a','Legacy'); CREATE TABLE messages(id INTEGER PRIMARY KEY AUTOINCREMENT,session_id TEXT,role TEXT,content TEXT,created_at DATETIME DEFAULT CURRENT_TIMESTAMP); INSERT INTO messages(session_id,role,content) VALUES('a','user','Original');");
  old.close();
  for (let pass = 0; pass < 2; pass++) {
    const db = openSessionDatabase(file), app = express(); app.use(express.json(), sessionRouter(db));
    const server = await listenForFetch(app);
    try {
      const res = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/sessions/a/exchange`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId: 'persist', userContent: 'New question', assistantContent: 'Saved answer' }) });
      assert.equal(res.status, 200);
      assert.equal((db.prepare('SELECT count(*) AS n FROM messages').get() as any).n, 3);
      assert.equal((db.prepare('SELECT content FROM messages WHERE id=1').get() as any).content, 'Original');
    } finally { server.close(); await once(server, 'close'); db.close(); }
  }
});

test('Only the selected AI provider is called for a successful answer', async () => {
  const calls: string[] = [];
  const answer = await withSelectedAI('ollama', {
    ollama: async () => { calls.push('ollama'); return ' 回應 '; },
    gemini: async () => { calls.push('gemini'); return '不應執行'; },
  });
  assert.equal(answer, '回應');
  assert.deepEqual(calls, ['ollama']);
});

test('Optional AI titles remain absent on failure without contacting the other provider', async () => {
  assert.equal(await withSelectedAI('gemini', {
    gemini: async () => { throw new Error('offline'); }, ollama: async () => assert.fail('Unexpected provider'),
  }), null);
  assert.equal(await withSelectedAI('ollama', { ollama: async () => ' ', gemini: async () => assert.fail('Unexpected provider') }), null);
});

test('HTTP errors cannot masquerade as successful writes, including HTML error pages', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ error: '儲存失敗' }), { status: 500 }));
  await assert.rejects(requestJson('/test'), /儲存失敗/);
  t.mock.method(globalThis, 'fetch', async () => new Response('<html>Bad gateway</html>', { status: 502 }));
  await assert.rejects(requestJson('/test'), /502/);
  t.mock.method(globalThis, 'fetch', async () => new Response('invalid', { status: 200 }));
  await assert.rejects(requestJson('/test'), /格式不正確/);
});
