const path = require('node:path');
const { fork } = require('node:child_process');
const { randomUUID, createHash } = require('node:crypto');
const { mkdir, cp, readFile, rm, access } = require('node:fs/promises');
const { publishInitialStore } = require('./initial-store.cjs');

const exists = async file => { try { await access(file); return true; } catch { return false; } };
const requiredSeedFiles = ['drugs.db', 'vision/index.db', 'vision/models/Xenova/dinov2-small/config.json',
  'vision/models/Xenova/dinov2-small/preprocessor_config.json', 'vision/models/Xenova/dinov2-small/onnx/model_quantized.onnx'];
async function prepareDesktopData(seed, userData) {
  const parent = path.resolve(userData), destination = path.join(parent, 'store');
  await mkdir(parent, { recursive: true });
  if (await exists(destination)) {
    for (const file of ['manifest.json', ...requiredSeedFiles]) {
      if (!await exists(path.join(destination, file))) throw new Error('桌面資料不完整，請保留現有資料並重新執行資料安裝。');
    }
    return { dataDir: destination, chatDb: path.join(parent, 'medsafe.db'), drugDb: path.join(destination, 'drugs.db'), vision: path.join(destination, 'vision') };
  }
  const staging = path.join(parent, `.seed-${randomUUID()}`);
  try {
    const manifest = JSON.parse(await readFile(path.join(seed, 'manifest.json'), 'utf8'));
    if (manifest.schema !== 1 || !Array.isArray(manifest.verify) || !requiredSeedFiles.every(file => manifest.verify.some(item => item?.path === file))) throw new Error('安裝資料清單無效。');
    await cp(seed, staging, { recursive: true, errorOnExist: true, force: false });
    for (const item of manifest.verify) {
      if (typeof item?.path !== 'string' || typeof item?.sha256 !== 'string') throw new Error('安裝資料路徑無效。');
      const file = path.resolve(staging, item.path);
      if (!file.startsWith(staging + path.sep) || !/^[a-f0-9]{64}$/.test(item.sha256)) throw new Error('安裝資料路徑無效。');
      const actual = createHash('sha256').update(await readFile(file)).digest('hex');
      if (actual !== item.sha256) throw new Error('安裝資料驗證失敗，請重新取得完整安裝檔。');
    }
    await publishInitialStore(staging, destination);
  } finally {
    if (path.dirname(staging) !== parent || !path.basename(staging).startsWith('.seed-')) throw new Error('Invalid staging cleanup path');
    await rm(staging, { recursive: true, force: true });
  }
  return { dataDir: destination, chatDb: path.join(parent, 'medsafe.db'), drugDb: path.join(destination, 'drugs.db'), vision: path.join(destination, 'vision') };
}

function startBackend({ appRoot, paths, execPath = process.execPath, electron = false, onExit = () => {}, timeoutMs = 45_000 }) {
  const child = fork(path.join(appRoot, 'dist-server/server.js'), [], {
    // The bundled server runs plain JavaScript; parent loaders/debug flags may
    // resolve from another directory or compete for the same inspector port.
    cwd: appRoot.endsWith('.asar') ? path.dirname(appRoot) : appRoot, execPath, execArgv: [], windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    env: { ...process.env, ...(electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}), NODE_ENV: 'production', HOST: '127.0.0.1', PORT: '0',
      CHAT_DB_PATH: paths.chatDb, DRUG_DB_PATH: paths.drugDb, VISION_DATA_DIR: paths.vision },
  });
  let stopped = false, ended = false, closing, errorText = '';
  child.stderr.on('data', chunk => { errorText = (errorText + chunk.toString()).slice(-4000); });
  // close also fires after a failed spawn, where exit is never emitted.
  const exited = new Promise(resolve => child.once('close', (code, signal) => { ended = true; resolve(); if (!stopped) onExit(code, signal); }));
  const stop = () => closing ||= (async () => {
    stopped = true; if (ended) return;
    const timeout = setTimeout(() => child.kill(), 12_000); timeout.unref();
    try { if (child.connected) child.send({ type: 'shutdown' }, () => {}); else child.kill(); await exited; }
    finally { clearTimeout(timeout); }
  })();
  return new Promise((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => fail(new Error('本機服務啟動逾時。')), timeoutMs);
    function fail(error) {
      if (settled) return; settled = true; clearTimeout(timeout);
      void stop().finally(() => reject(Object.assign(error, { details: errorText })));
    }
    child.once('error', error => fail(error));
    child.once('exit', () => fail(new Error('本機服務未完成啟動，請查看桌面版記錄。')));
    child.on('message', async message => {
      if (settled || message?.type !== 'ready' || !Number.isInteger(message.port) || message.port < 1 || message.port > 65535) return;
      const origin = `http://127.0.0.1:${message.port}`;
      try {
        const response = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(10_000) });
        const health = await response.json();
        if (!response.ok || health.service !== 'medsafe' || health.status !== 'ready') throw new Error('本機藥品資料尚未就緒。');
        if (settled || ended) return;
        settled = true; clearTimeout(timeout); resolve({ origin, child, stop, health });
      } catch (error) { fail(error); }
    });
  });
}

module.exports = { prepareDesktopData, startBackend, requiredSeedFiles };
