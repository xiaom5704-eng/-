import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile, rm, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import Database from 'better-sqlite3';

const root = fileURLToPath(new URL('../', import.meta.url));
const executable = path.join(root, 'release/windows/win-unpacked/智慧醫療助理.exe');
await access(executable);
await mkdir(path.join(root, 'test-results'), { recursive: true });
const profile = await mkdtemp(path.join(root, 'test-results/desktop-profile-'));
const env = { ...process.env, GEMINI_API_KEY: '', VITE_GEMINI_API_KEY: '' }; delete env.ELECTRON_RUN_AS_NODE;
const readyFile = path.join(profile, 'desktop-ready.json'), stopFile = path.join(profile, 'stop-desktop-check');
const reportFile = path.join(root, 'test-results/desktop-check.json');
let child, exit, ready;
async function stop() {
  if (!child) return;
  await writeFile(stopFile, 'stop');
  const timer = setTimeout(() => child.kill(), 15_000); timer.unref();
  try { await exit; } finally { clearTimeout(timer); }
  if (ready) {
    await assert.rejects(fetch(`${ready.origin}/api/health`, { signal: AbortSignal.timeout(2000) }));
    assert.throws(() => process.kill(ready.backendPid, 0), /ESRCH|not found/i, 'desktop backend must stop with its parent');
  }
  child = undefined;
}
async function launch() {
  await rm(readyFile, { force: true }); await rm(stopFile, { force: true });
  child = spawn(executable, ['--medsafe-smoke', '--user-data', profile], { cwd: root, env, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  let errorText = '', spawnError;
  child.stderr.on('data', chunk => { errorText = (errorText + chunk).slice(-4000); });
  child.once('error', error => { spawnError = error; });
  exit = new Promise(resolve => child.once('close', resolve));
  const until = Date.now() + 120_000;
  while (Date.now() < until) {
    if (spawnError) throw spawnError;
    if (child.exitCode !== null) {
      let details = ''; try { details = await readFile(path.join(profile, 'startup-error.log'), 'utf8'); } catch {}
      throw new Error(`Desktop exited before ready (${child.exitCode}): ${details || errorText}`);
    }
    try { ready = JSON.parse(await readFile(readyFile, 'utf8')); return ready; } catch {}
    await delay(250);
  }
  throw new Error('Desktop readiness timeout');
}
async function json(endpoint, body) {
  const response = await fetch(`${ready.origin}${endpoint}`, { ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), signal: AbortSignal.timeout(130_000) });
  const result = await response.json(); assert.ok(response.ok, `${endpoint}: ${response.status} ${result.error || ''}`); return result;
}
try {
  await launch(); console.log('Packaged Electron backend and copied datasets are ready.');
  assert.equal(ready.health.status, 'ready'); assert.ok(ready.vision.ready);
  assert.equal((await json('/api/sessions')).length, 0, 'no user chats are bundled');
  const demo = await json('/api/medications/demo', {});
  assert.equal(demo.medications.length, 5); assert.equal(demo.safety.patient.age.value, '1');
  assert.ok(demo.safety.alerts.length > 0); assert.ok(demo.safety.alerts.every(alert => alert.sources.length));
  const search = await json('/api/medications/search?q=KBT'); assert.equal(search.candidates.length, 1);
  const ocrSearch = await json('/api/medications/search?q=' + encodeURIComponent('伏冒 普拿疼 加強锭'));
  assert.equal(ocrSearch.candidates.length, 2, 'mixed-script OCR must find both original TFDA licenses');
  assert.ok(ocrSearch.candidates.every(item => item.name === '普拿疼伏冒加強錠'));
  const candidate = search.candidates[0];
  const imageUrl = Object.values(candidate.appearance.localImageUrls)[0]; assert.ok(imageUrl);
  const imageResponse = await fetch(`${ready.origin}${imageUrl}`); assert.ok(imageResponse.ok);
  const image = Buffer.from(await imageResponse.arrayBuffer());
  const inference = await json('/api/medications/vision/search', { images: [`data:image/webp;base64,${image.toString('base64')}`] });
  assert.ok(inference.candidates.some(item => item.drug.id === candidate.id), 'reference image must retrieve its own product within candidates');
  console.log('Packaged SQLite, Sharp and ONNX inference passed (reference image, not an accuracy test).');
  for (const asset of ['/favicon.ico', '/ocr/worker.min.js', '/ocr/lang/chi_tra.traineddata.gz']) {
    const response = await fetch(`${ready.origin}${asset}`); assert.equal(response.status, 200, asset); await response.body.cancel();
  }
  const sessionId = 'desktop-synthetic-test';
  await json('/api/sessions', { id: sessionId, title: '人工桌面重啟測試' });
  await json(`/api/sessions/${sessionId}/medication-report`, { content: '人工測試報告，非個人醫療資料。' });
  const before = await json(`/api/messages/${sessionId}`), first = ready;
  await stop(); await launch();
  assert.deepEqual(await json(`/api/messages/${sessionId}`), before);
  const repeated = await json('/api/medications/demo', {}); assert.equal(repeated.medications.length, 5);
  const output = { checkedAt: new Date().toISOString(), profile, runtime: ready.runtime, health: ready.health, vision: ready.vision,
    firstPort: new URL(first.origin).port, restartPort: new URL(ready.origin).port, dataAndMessagesPreserved: true,
    mixedScriptOcrSearch: { query: '伏冒 普拿疼 加強锭', count: ocrSearch.candidates.length, originalNamesPreserved: true },
    case: { medications: demo.medications.length, alerts: demo.safety.alerts.length, pairs: demo.interactions.length,
      savedLabels: demo.medications.map(entry => ({ id: entry.drug.id, status: entry.labelStatus, labels: entry.labels.length })) },
    referenceInference: { candidateCount: inference.candidates.length, expectedId: candidate.id, recovered: true, independentAccuracyTest: false },
    limitation: 'Checks packaged backend/API and assets. Native desktop visual/device checks are separate.' };
  // The original Node ABI must remain usable after desktop rebuild.
  const db = new Database(':memory:'); assert.equal(db.prepare('SELECT 1 n').get().n, 1); db.close();
  await writeFile(reportFile, JSON.stringify({ status: 'passed', ...output }, null, 2));
  if (process.argv.includes('--hold')) {
    console.log(JSON.stringify({ browserVerificationOrigin: ready.origin, stopFile }));
    await exit;
  }
  await stop();
  console.log('Desktop restart persistence, child-process shutdown and unchanged web SQLite passed.');
} catch (error) {
  // A failed current check must never leave yesterday's success looking current.
  try {
    const previous = JSON.parse(await readFile(reportFile, 'utf8'));
    if (previous.status !== 'failed') await writeFile(path.join(root, 'test-results/desktop-check.previous.json'), JSON.stringify(previous, null, 2));
  } catch {}
  await writeFile(reportFile, JSON.stringify({ status: 'failed', checkedAt: new Date().toISOString(), executable, profile,
    code: error.code, error: error.message, limitation: 'This build has not passed packaged runtime verification. Earlier successes do not validate this executable.' }, null, 2));
  throw error;
} finally { await stop(); }
