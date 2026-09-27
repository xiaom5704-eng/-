import test from 'node:test';
import assert from 'node:assert/strict';
import { medicationSaveAttempt } from '../shared/medication-save';

test('Report save retries reuse the exact snapshot while a changed age, source or summary gets a new identity', () => {
  let ids = 0;
  const newId = () => `report-${++ids}`;
  const first = medicationSaveAttempt('1 個月\n來源：原始仿單\n查核日期：原日期', null, newId);
  assert.equal(medicationSaveAttempt(first.content, first, newId), first);
  assert.equal(ids, 1);
  const changed = medicationSaveAttempt('70 歲\n來源：原始仿單\n查核日期：原日期', first, newId);
  assert.notEqual(changed.requestId, first.requestId);
  const translated = medicationSaveAttempt(changed.content + '\nEnglish summary', changed, newId);
  assert.notEqual(translated.requestId, changed.requestId);
  assert.equal(first.content, '1 個月\n來源：原始仿單\n查核日期：原日期');
});
