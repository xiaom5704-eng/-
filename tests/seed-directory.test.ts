import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { moveSeedDirectory } from '../scripts/seed-directory.mjs';

const source = path.resolve('release/seed-next'), destination = path.resolve('release/seed');
test('Seed directory replacement retries transient locks with a finite wait and preserves paths', async () => {
  let calls = 0; const waits: number[] = [];
  await moveSeedDirectory(source, destination, async (from: string, to: string) => {
    assert.equal(from, source); assert.equal(to, destination);
    if (++calls < 3) throw Object.assign(new Error('file locked'), { code: 'EPERM' });
  }, async (duration: number) => { waits.push(duration); });
  assert.equal(calls, 3); assert.deepEqual(waits, [100, 200]);
});
test('A persistent lock terminates; missing sources and invalid move targets are never retried', async () => {
  let calls = 0, waits = 0;
  await assert.rejects(moveSeedDirectory(source, destination, async () => {
    calls++; throw Object.assign(new Error('still locked'), { code: 'EBUSY' });
  }, async () => { waits++; }), /still locked/);
  assert.equal(calls, 6); assert.equal(waits, 5);
  calls = 0;
  const missing = async () => { calls++; throw Object.assign(new Error('missing'), { code: 'ENOENT' }); };
  await assert.rejects(moveSeedDirectory(source, destination, missing, async () => assert.fail('must not wait')), /missing/);
  assert.equal(calls, 1);
  for (const target of [source, path.resolve('elsewhere/seed'), path.resolve('release/unrelated')])
    await assert.rejects(moveSeedDirectory(source, target, missing), /Unsafe/);
  assert.equal(calls, 1, 'invalid paths are rejected before touching disk');
});
