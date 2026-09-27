import { rename as fsRename } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';

// Windows scanners/sync clients can briefly lock a completed directory. Retry
// only the three build-owned seed slots; never relax filesystem permissions.
export async function moveSeedDirectory(source, destination, rename = fsRename, wait = milliseconds => delay(milliseconds)) {
  const from = path.resolve(source), to = path.resolve(destination);
  const slots = ['seed', 'seed-next', 'seed-previous'];
  if (path.dirname(from) !== path.dirname(to) || !slots.includes(path.basename(from)) || !slots.includes(path.basename(to)) || from === to)
    throw new Error('Unsafe seed directory move');
  const waits = [100, 200, 400, 800, 1000];
  for (let attempt = 0; ; attempt++) {
    try { await rename(from, to); return; }
    catch (error) {
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt === waits.length) throw error;
      await wait(waits[attempt]);
    }
  }
}
