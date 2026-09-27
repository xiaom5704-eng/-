const path = require('node:path');
const { rename: fsRename } = require('node:fs/promises');
const { setTimeout: delay } = require('node:timers/promises');

// Publishing a verified first-launch copy can briefly fail while Windows scans
// its files. Retry this exact rename only; never remove an existing store or
// relax filesystem permissions to force installation.
async function publishInitialStore(source, destination, rename = fsRename, wait = delay) {
  const from = path.resolve(source), to = path.resolve(destination);
  if (path.dirname(from) !== path.dirname(to) || path.basename(to) !== 'store' ||
      !/^\.seed-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(path.basename(from)))
    throw new Error('Invalid initial store paths');
  const waits = [100, 200, 400, 800, 1000];
  for (let attempt = 0; ; attempt++) {
    try { await rename(from, to); return; }
    catch (error) {
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt === waits.length) throw error;
      await wait(waits[attempt]);
    }
  }
}
module.exports = { publishInitialStore };
