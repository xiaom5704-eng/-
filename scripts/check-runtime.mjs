import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scratch = await mkdtemp(path.join(os.tmpdir(), 'medsafe-startup-check-'));
const env = { ...process.env, NODE_ENV: 'production', PORT: '0', HOST: '127.0.0.1', CHAT_DB_PATH: path.join(scratch, 'chat.db') };
// Let the server resolve its own .env and default data paths from another working directory.
delete env.DRUG_DB_PATH; delete env.VISION_DATA_DIR;
const child = fork(path.join(root, 'dist-server/server.js'), [], { cwd: scratch, env, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
const exited = once(child, 'exit');
try {
  const ready = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Startup timed out')), 30_000);
    child.on('message', message => { if (message?.type === 'ready') { clearTimeout(timeout); resolve(message); } });
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', code => { clearTimeout(timeout); reject(new Error(`Service exited before readiness: ${code}`)); });
  });
  const base = `http://127.0.0.1:${ready.port}`;
  const health = await (await fetch(`${base}/api/health`)).json();
  assert.equal(health.service, 'medsafe'); assert.equal(health.status, 'ready');
  const vision = await (await fetch(`${base}/api/medications/vision/status`)).json();
  assert.equal(vision.ready, true);
  const search = await (await fetch(`${base}/api/medications/search?q=KBT`)).json();
  assert.equal(search.candidates[0].id, '內衛藥製字第007592號');
  const imageUrl = Object.values(search.candidates[0].appearance.localImageUrls)[0];
  assert.ok(imageUrl.startsWith('/api/medications/reference-images/'));
  const image = await fetch(base + imageUrl);
  assert.equal(image.status, 200); assert.match(image.headers.get('content-type'), /image\/webp/);
  await image.arrayBuffer();
  assert.equal((await fetch(base)).status, 200);
  const unknown = await fetch(`${base}/api/unknown`); assert.equal(unknown.status, 404);
  assert.match(unknown.headers.get('content-type'), /json/);
  const report = { checkedAt: new Date().toISOString(), launchedOutsideProject: true, health,
    visionReady: vision.ready, foundLicense: search.candidates[0].id, localImageStatus: image.status, unknownApiStatus: unknown.status };
  await mkdir(path.join(root, 'test-results'), { recursive: true });
  await writeFile(path.join(root, 'test-results/runtime-check.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  if (child.connected) child.send({ type: 'shutdown' });
  const force = setTimeout(() => child.kill(), 15_000);
  try { await exited; } finally { clearTimeout(force); }
  assert.equal(path.dirname(path.resolve(scratch)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(scratch).startsWith('medsafe-startup-check-'));
  await rm(scratch, { recursive: true, force: true });
}
