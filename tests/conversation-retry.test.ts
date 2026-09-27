import test from 'node:test';
import assert from 'node:assert/strict';
import { unansweredQuestion } from '../shared/conversation-retry';

test('Retry uses the original saved question and history without repeating the last user prompt', () => {
  const messages = [
    { id: 1, session_id: 'a', role: 'user', content: 'Earlier question' },
    { id: 2, session_id: 'a', role: 'assistant', content: 'Earlier answer' },
    { id: 3, session_id: 'a', role: 'user', content: '諮詢對象年齡：30 歲\nOriginal question', client_id: 'original:user' },
  ];
  const retry = unansweredQuestion(messages, 'a')!;
  assert.equal(retry.requestId, 'original');
  assert.equal(retry.message.content, messages[2].content);
  assert.deepEqual(retry.history, messages.slice(0, 2));
  assert.equal(unansweredQuestion(messages, 'b'), null);
  assert.equal(unansweredQuestion([...messages, { id: 4, session_id: 'a', role: 'assistant', content: 'Already answered' }], 'a'), null);
});

test('Legacy questions get a stable retry identity; empty or unsaved histories cannot be retried', () => {
  const legacy = { id: 9, session_id: 'a', role: 'user', content: 'Old unanswered question', client_id: null };
  assert.equal(unansweredQuestion([legacy], 'a')!.requestId, 'reply-9');
  assert.equal(unansweredQuestion([legacy], 'a')!.requestId, 'reply-9');
  assert.equal(unansweredQuestion([], 'a'), null);
  assert.equal(unansweredQuestion([{ ...legacy, id: undefined }], 'a'), null);
  assert.equal(unansweredQuestion([{ ...legacy, client_id: ':user' }], 'a'), null);
});
