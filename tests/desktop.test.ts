import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { prepareDesktopData, startBackend, requiredSeedFiles } = require('../electron/backend.cjs');
const { publishInitialStore } = require('../electron/initial-store.cjs');
async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'medsafe-desktop-'));
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('medsafe-desktop-'));
    await rm(root, { recursive: true, force: true });
  });
  return root;
}
async function makeSeed(root: string) {
  const seed = path.join(root, 'seed');
  const verify = [];
  for (const file of requiredSeedFiles as string[]) {
    const destination = path.join(seed, file), contents = `SYNTHETIC seed ${file}`;
    await mkdir(path.dirname(destination), { recursive: true }); await writeFile(destination, contents);
    verify.push({ path: file, sha256: createHash('sha256').update(contents).digest('hex') });
  }
  await writeFile(path.join(seed, 'manifest.json'), JSON.stringify({ schema: 1, verify }));
  return { seed, verify };
}

test('Desktop first launch copies verified public seed, while restart preserves modified drugs and chats', async t => {
  const root = await fixture(t), { seed } = await makeSeed(root), profile = path.join(root, 'profile');
  const installed = await prepareDesktopData(seed, profile);
  assert.equal(installed.drugDb, path.join(profile, 'store/drugs.db'));
  await writeFile(installed.drugDb, 'UPDATED PUBLIC DATA'); await writeFile(installed.chatDb, 'SYNTHETIC USER CHAT');
  const again = await prepareDesktopData(seed, profile);
  assert.deepEqual(again, installed);
  assert.equal(await readFile(again.drugDb, 'utf8'), 'UPDATED PUBLIC DATA');
  assert.equal(await readFile(again.chatDb, 'utf8'), 'SYNTHETIC USER CHAT');
  assert.deepEqual((await readdir(profile)).sort(), ['medsafe.db', 'store']);
});

test('First-launch publication retries temporary Windows locks at the exact verified destination', async () => {
  const from = path.resolve('fixture-profile/.seed-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'), to = path.resolve('fixture-profile/store');
  let calls = 0; const waits: number[] = [];
  await publishInitialStore(from, to, async (source: string, target: string) => {
    assert.equal(source, from); assert.equal(target, to);
    if (++calls <= 3) throw Object.assign(new Error('temporary lock'), { code: ['EPERM','EACCES','EBUSY'][calls-1] });
  }, async (ms: number) => { waits.push(ms); });
  assert.equal(calls,4); assert.deepEqual(waits,[100,200,400]);
});

test('First-launch publication stops on persistent locks, other errors and unsafe paths without deleting data', async () => {
  const from = path.resolve('fixture-profile/.seed-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'), to = path.resolve('fixture-profile/store');
  let calls = 0, waits = 0;
  await assert.rejects(publishInitialStore(from,to,async()=>{calls++;throw Object.assign(new Error('locked'),{code:'EPERM'});},async()=>{waits++;}),/locked/);
  assert.equal(calls,6);assert.equal(waits,5);
  calls=0;
  const missing=async()=>{calls++;throw Object.assign(new Error('missing'),{code:'ENOENT'});};
  await assert.rejects(publishInitialStore(from,to,missing,async()=>assert.fail('unexpected wait')),/missing/);
  assert.equal(calls,1);
  for(const [source,target] of [[from,from],[from,path.resolve('elsewhere/store')],[path.resolve('fixture-profile/user-files'),to]])
    await assert.rejects(publishInitialStore(source,target,missing),/Invalid initial store paths/);
  assert.equal(calls,1);
});

test('Desktop refuses corrupt or incomplete seed without publishing half-copied data', async t => {
  const root = await fixture(t), { seed, verify } = await makeSeed(root), profile = path.join(root, 'profile');
  await writeFile(path.join(seed, 'drugs.db'), 'TAMPERED');
  await assert.rejects(prepareDesktopData(seed, profile), /驗證失敗/);
  assert.deepEqual(await readdir(profile), []);
  await writeFile(path.join(seed, 'manifest.json'), JSON.stringify({ schema: 1, verify: verify.slice(1) }));
  await assert.rejects(prepareDesktopData(seed, profile), /清單無效/);
  await assert.rejects(access(path.join(profile, 'store')));
});

test('Desktop rejects a traversal manifest and leaves an existing incomplete profile untouched', async t => {
  const root = await fixture(t), { seed, verify } = await makeSeed(root), profile = path.join(root, 'profile');
  await writeFile(path.join(seed, 'manifest.json'), JSON.stringify({ schema: 1, verify: [...verify, { path: '../outside', sha256: '0'.repeat(64) }] }));
  await assert.rejects(prepareDesktopData(seed, profile), /路徑無效/);
  assert.deepEqual(await readdir(profile), []);
  await mkdir(path.join(profile, 'store')); await writeFile(path.join(profile, 'store/drugs.db'), 'DO NOT REPLACE');
  await assert.rejects(prepareDesktopData(seed, profile), /資料不完整/);
  assert.equal(await readFile(path.join(profile, 'store/drugs.db'), 'utf8'), 'DO NOT REPLACE');
});

async function backendFixture(root: string, contents: string) {
  await mkdir(path.join(root, 'dist-server'), { recursive: true });
  await writeFile(path.join(root, 'dist-server/server.js'), contents);
  return { appRoot: root, paths: { chatDb: path.join(root, 'chat.db'), drugDb: path.join(root, 'drugs.db'), vision: path.join(root, 'vision') }, timeoutMs: 2000 };
}
const fakeServer = (status: string) => `
const http = require('node:http');
const fs = require('node:fs');
const server = http.createServer((req, res) => { res.setHeader('content-type','application/json'); res.end(JSON.stringify({service:'medsafe',status:'${status}',host:process.env.HOST,port:process.env.PORT,db:process.env.CHAT_DB_PATH,execArgv:process.execArgv})); });
server.listen(Number(process.env.PORT),process.env.HOST,()=>process.send({type:'ready',port:server.address().port}));
process.on('message', message => { if(message.type==='shutdown') server.close(()=>{fs.writeFileSync(process.env.CHAT_DB_PATH,'closed'); process.exit(0);}); });
process.on('disconnect',()=>process.exit(0));`;

test('Desktop waits for loopback health readiness on a free port and closes its service', async t => {
  const root = await fixture(t), options = await backendFixture(root, fakeServer('ready'));
  const backend = await startBackend(options);
  try {
    assert.match(backend.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.equal(backend.health.host, '127.0.0.1'); assert.equal(backend.health.port, '0');
    assert.equal(backend.health.db, options.paths.chatDb);
    assert.deepEqual(backend.health.execArgv, [], 'the plain backend must not inherit parent TypeScript loaders or debugger flags');
  } finally { await backend.stop(); await backend.stop(); }
  assert.equal(await readFile(options.paths.chatDb, 'utf8'), 'closed');
  await assert.rejects(fetch(`${backend.origin}/api/health`));
});

test('Desktop reports missing data, early process exit, startup timeout and failed spawn', async t => {
  const root = await fixture(t);
  await assert.rejects(startBackend(await backendFixture(root, fakeServer('needs_data'))), /資料尚未就緒/);
  // Failures reject only after service cleanup completes, so the fixture can safely be replaced.
  await assert.rejects(startBackend(await backendFixture(root, 'process.exit(2);')), /未完成啟動/);
  await assert.rejects(startBackend({ ...await backendFixture(root, 'setInterval(()=>{},100); process.on("message",()=>process.exit(0));'), timeoutMs: 150 }), /逾時/);
  await assert.rejects(startBackend({ ...await backendFixture(root, ''), execPath: path.join(root, 'missing-node.exe') }), /ENOENT/);
});
