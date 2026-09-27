import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import AdmZip from 'adm-zip';
import path from 'node:path';
import os from 'node:os';
import { loadRuntimeConfig, projectRoot } from '../server/runtime';
import { startApplication } from '../server/application';
import { openDrugDatabase } from '../server/medications/store';
import { importTfda } from '../server/medications/importers';
import { installPublicData } from '../scripts/install-public-data.mjs';

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

test('Development instances use their own HTTP port for HMR and close independently', async t => {
  const roots = [fixture(t), fixture(t)];
  roots.forEach(root => writeFileSync(path.join(root, 'index.html'), '<html><body>SYNTHETIC DEVELOPMENT PAGE</body></html>'));
  const services: Awaited<ReturnType<typeof startApplication>>[] = [];
  try {
    for (const root of roots) services.push(await startApplication({ ...configFor(root), production: false }));
    for (const service of services) {
      const base = `http://127.0.0.1:${service.port}`;
      const script = await (await fetch(base + '/@vite/client')).text();
      const match = /const wsToken = ("[^"]*")/.exec(script); assert.ok(match, 'Vite serves its public HMR token');
      const socket = new WebSocket(`ws://127.0.0.1:${service.port}/?token=${encodeURIComponent(JSON.parse(match[1]))}`, 'vite-hmr');
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await new Promise<void>((resolve, reject) => {
          timer = setTimeout(() => reject(new Error('HMR did not connect on the application port')), 2000);
          socket.addEventListener('message', event => {
            if (JSON.parse(String(event.data)).type === 'connected') resolve();
          });
          socket.addEventListener('error', () => reject(new Error('HMR connection failed')));
        });
      } finally { clearTimeout(timer); socket.close(); }
    }
    await services[0].close();
    assert.equal((await fetch(`http://127.0.0.1:${services[1].port}/api/health`)).status, 200);
  } finally { await Promise.all(services.map(service => service.close())); }
});

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
  openDrugDatabase(config.paths.drugDb).close();
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

test('Starting before data installation leaves no blocking empty data directory; install and restart recover search without losing chats', async t => {
  const root = fixture(t), config = configFor(root);
  mkdirSync(config.paths.dist); writeFileSync(path.join(config.paths.dist, 'index.html'), 'synthetic');
  let service = await startApplication(config);
  try {
    const base = `http://127.0.0.1:${service.port}`;
    const status = await (await fetch(`${base}/api/medications/status`)).json();
    assert.equal(existsSync(path.join(root, 'data')), false, 'opening the web app must not block first data:install');
    assert.deepEqual(status.dataSetup, { storage: 'temporary', installation: 'available' });
    for (const route of ['/search?q=TEST', '/name-suggestions?q=TEST']) {
      const response = await fetch(`${base}/api/medications${route}`);
      assert.equal(response.status, 503);
      assert.match((await response.json()).error, /尚未.*安裝/);
    }
    const match = await fetch(`${base}/api/medications/match`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ observations: [{ name: 'TEST', strength: '', dosageForm: '' }] }) });
    assert.equal(match.status, 503);
    const created = await fetch(`${base}/api/sessions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'before-install', title: '安裝前的人工測試對話' }) });
    assert.equal(created.status, 200);
    const sourcePath = path.join(root, 'fixture.db'), source = openDrugDatabase(sourcePath);
    importTfda(source, [{ 許可證字號: 'SYNTHETIC001', 中文品名: '人工測試品', 英文品名: 'TEST', 主成分略述: 'Test ingredient' }]);
    source.close();
    const files = new Map([
      ['drugs.db', readFileSync(sourcePath)], ['vision/index.db', Buffer.from('SYNTHETIC INDEX')],
      ...['config.json', 'preprocessor_config.json', 'onnx/model_quantized.onnx'].map(file => [`vision/models/Xenova/dinov2-small/${file}`, Buffer.from('SYNTHETIC MODEL')] as const),
    ]);
    const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
    const zip = new AdmZip();
    for (const [file, bytes] of files) zip.addFile(`data/${file}`, bytes);
    zip.addFile('data/manifest.json', Buffer.from(JSON.stringify({ schema: 1, preparedAt: '2026-09-28T00:00:00Z', verify: [...files].map(([file, bytes]) => ({ path: file, sha256: hash(bytes) })) })));
    const bytes = zip.toBuffer(), archivePath = path.join(root, 'input.zip'); writeFileSync(archivePath, bytes);
    await installPublicData({ projectRoot: root, archivePath, expectedHash: hash(bytes), download: async () => assert.fail('offline installation must not fetch') });
    const installed = await (await fetch(`${base}/api/health`)).json();
    assert.equal(installed.status, 'needs_data');
    assert.deepEqual(installed.dataSetup, { storage: 'temporary', installation: 'restart_required' });
    await service.close(); service = await startApplication(config);
    const next = `http://127.0.0.1:${service.port}`;
    const search = await fetch(`${next}/api/medications/search?q=TEST`);
    assert.equal(search.status, 200); assert.equal((await search.json()).candidates[0].id, 'SYNTHETIC001');
    const noMatch = await fetch(`${next}/api/medications/search?q=UNKNOWN`);
    assert.equal(noMatch.status, 200); assert.equal((await noMatch.json()).candidates.length, 0);
    const sessions = await (await fetch(`${next}/api/sessions`)).json();
    assert.equal(sessions.length, 1); assert.equal(sessions[0].id, 'before-install');
  } finally { await service.close(); }
});

test('Missing custom paths and existing empty directories are distinguished; an invalid existing database is never silently replaced', async t => {
  const root = fixture(t), config = configFor(root);
  mkdirSync(config.paths.dist); writeFileSync(path.join(config.paths.dist, 'index.html'), 'synthetic');
  mkdirSync(path.join(root, 'data')); writeFileSync(path.join(root, 'data', 'keep.txt'), 'USER FILE');
  const service = await startApplication(config);
  try {
    const response = await (await fetch(`http://127.0.0.1:${service.port}/api/medications/status`)).json();
    assert.deepEqual(response.dataSetup, { storage: 'temporary', installation: 'existing_directory' });
    assert.deepEqual(readdirSync(path.join(root, 'data')), ['keep.txt']);
  } finally { await service.close(); }
  const custom = { ...config, paths: { ...config.paths, drugDb: path.join(root, 'custom', 'drugs.db') } };
  const customService = await startApplication(custom);
  try {
    const response = await (await fetch(`http://127.0.0.1:${customService.port}/api/health`)).json();
    assert.deepEqual(response.dataSetup, { storage: 'temporary', installation: 'custom_paths' });
    assert.equal(existsSync(path.join(root, 'custom')), false);
    assert.ok(!JSON.stringify(response).includes(root));
  } finally { await customService.close(); }
  writeFileSync(config.paths.drugDb, 'INVALID USER DATABASE');
  await assert.rejects(startApplication(config));
  assert.equal(readFileSync(config.paths.drugDb, 'utf8'), 'INVALID USER DATABASE');
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
