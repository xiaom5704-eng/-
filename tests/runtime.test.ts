import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadRuntimeConfig, projectRoot } from '../server/runtime';
import { startApplication } from '../server/application';
import { openDrugDatabase } from '../server/medications/store';
import { importTfda } from '../server/medications/importers';

function fixture(t: TestContext) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'medsafe-runtime-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('medsafe-runtime-'));
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}

function configFor(root: string) {
  return loadRuntimeConfig(root, { PORT: '0', HOST: '127.0.0.1', NODE_ENV: 'production', CHAT_DB_PATH: 'nested/chat.db' }, false);
}

test('Runtime resolves defaults and relative settings from the application, not the launching directory', t => {
  const root = fixture(t);
  writeFileSync(path.join(root, '.env'), 'DRUG_DB_PATH=imported/drugs.db\nPORT=3100\nVISION_DATA_DIR=references\n');
  const env = { PORT: '3200', CHAT_DB_PATH: path.join(root, 'custom', 'chat.db') };
  const config = loadRuntimeConfig(root, env);
  assert.equal(config.port, 3200, 'process settings take precedence over .env');
  assert.equal(config.paths.drugDb, path.join(root, 'imported', 'drugs.db'));
  assert.equal(config.paths.vision, path.join(root, 'references'));
  assert.equal(config.paths.chatDb, env.CHAT_DB_PATH);
  assert.equal(config.paths.dist, path.join(root, 'dist'));
  assert.ok(existsSync(path.join(projectRoot, 'package.json')));
  for (const PORT of ['-1', '1.2', 'NaN', '65536', '1e3', '']) assert.throws(() => loadRuntimeConfig(root, { PORT }, false), /PORT/);
});

test('Missing frontend build fails before creating blank databases', async t => {
  const root = fixture(t), config = configFor(root);
  await assert.rejects(startApplication(config), /npm run build/);
  assert.equal(existsSync(config.paths.chatDb), false);
  assert.equal(existsSync(config.paths.drugDb), false);
});

test('Health identifies missing datasets, API errors stay JSON, and conversations survive service restart', async t => {
  const root = fixture(t), config = configFor(root);
  mkdirSync(config.paths.dist);
  writeFileSync(path.join(config.paths.dist, 'index.html'), '<html><body>SYNTHETIC FRONTEND</body></html>');
  let service = await startApplication(config);
  const base = `http://127.0.0.1:${service.port}`;
  try {
    const health = await (await fetch(`${base}/api/health`)).json();
    assert.equal(health.status, 'needs_data'); assert.equal(health.service, 'medsafe');
    assert.deepEqual(health.needsData, ['tfda', 'ddinter', 'tfda_appearance', 'tfda_labels']);
    assert.ok(!JSON.stringify(health).includes(root), 'health does not expose filesystem paths');
    const source = openDrugDatabase(config.paths.drugDb);
    importTfda(source, [{ 許可證字號: 'SYNTHETIC001', 中文品名: '人工測試品', 英文品名: 'TEST', 主成分略述: 'Test ingredient' }]);
    source.close();
    const populated = await (await fetch(`${base}/api/health`)).json();
    assert.equal(populated.datasets[0].count, 1);
    assert.deepEqual(populated.needsData, ['ddinter', 'tfda_appearance', 'tfda_labels']);
    const unknown = await fetch(`${base}/api/not-a-route`);
    assert.equal(unknown.status, 404); assert.match(unknown.headers.get('content-type')!, /json/);
    assert.ok((await unknown.json()).error);
    const malformed = await fetch(`${base}/api/sessions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{malformed' });
    assert.equal(malformed.status, 400); assert.deepEqual(await malformed.json(), { error: '資料格式錯誤，請重新送出。' });
    assert.equal((await fetch(`${base}/assets/missing.js`)).status, 404);
    assert.match(await (await fetch(`${base}/conversation/demo`)).text(), /SYNTHETIC FRONTEND/);
    const created = await fetch(`${base}/api/sessions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'runtime-test', title: '人工測試對話' }) });
    assert.equal(created.status, 200);
    await service.close(); await service.close();
    service = await startApplication(config);
    const sessions = await (await fetch(`http://127.0.0.1:${service.port}/api/sessions`)).json();
    assert.equal(sessions.length, 1); assert.equal(sessions[0].title, '人工測試對話');
  } finally { await service.close(); }
});

test('A port collision fails promptly and releases database resources for a retry', async t => {
  const root = fixture(t), config = configFor(root);
  mkdirSync(config.paths.dist); writeFileSync(path.join(config.paths.dist, 'index.html'), 'synthetic');
  const first = await startApplication(config);
  try {
    await assert.rejects(startApplication({ ...config, port: first.port }), (error: NodeJS.ErrnoException) => error.code === 'EADDRINUSE');
    const retry = await startApplication(config);
    await retry.close();
  } finally { await first.close(); }
});
