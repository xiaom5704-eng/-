import test from 'node:test';
import assert from 'node:assert/strict';
import { questionSaveAttempt } from '../shared/question-save';

test('Question retry retains the first session, request identity and age snapshot until confirmed', () => {
  let created=0; const newId=()=>`id-${++created}`;
  const question='諮詢對象年齡：30 歲\n人工問題';
  const first=questionSaveAttempt(question,null,null,newId);
  assert.equal(first.sessionId,'id-2'); assert.equal(first.requestId,'id-1');
  assert.ok(first.newSessionTitle);
  assert.equal(questionSaveAttempt(question,null,first,newId),first);
  assert.equal(created,2);
  const changed=questionSaveAttempt(question.replace('30','70'),null,first,newId);
  assert.notEqual(changed.requestId,first.requestId); assert.notEqual(changed.sessionId,first.sessionId);
  assert.equal(first.content,question);
  const other=questionSaveAttempt(question,'other-session',first,newId);
  assert.equal(other.sessionId,'other-session'); assert.equal(other.newSessionTitle,undefined);
  assert.notEqual(other.requestId,first.requestId);
  assert.equal(questionSaveAttempt(question,'other-session',other,newId),other);
  const later=questionSaveAttempt(question,'other-session',null,newId);
  assert.notEqual(later.requestId,other.requestId,'a later intentional identical question remains a new send');
});
