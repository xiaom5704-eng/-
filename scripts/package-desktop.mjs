import { spawn } from 'node:child_process';
import { mkdir, cp, readFile, writeFile, readdir, rm, access, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import Database from 'better-sqlite3';
import { moveSeedDirectory } from './seed-directory.mjs';
import { loadDesktopTools } from './desktop-tools.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const release = path.join(root, 'release'), stage = path.join(release, 'app'), seed = path.join(release, 'seed');
const args = process.argv.slice(2);
if (args.some(arg => !['--dir', '--prepare-only'].includes(arg))) throw new Error('只支援 --dir 或 --prepare-only。');
const desktopTools = loadDesktopTools(root);
const env = { ...process.env, GEMINI_API_KEY: '', VITE_GEMINI_API_KEY: '' };
delete env.ELECTRON_RUN_AS_NODE;
const npm = process.env.npm_execpath;
if (!npm) throw new Error('請透過 npm run electron:build 執行。');
function run(script, args, cwd = root) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { cwd, env, stdio: 'inherit', windowsHide: true });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Desktop build step failed (${code}): ${path.basename(script)}`)));
  });
}
async function removeBuildDirectory(directory) {
  const resolved = path.resolve(directory);
  if (path.dirname(resolved) !== release || !['seed', 'seed-next', 'seed-previous'].includes(path.basename(resolved))) throw new Error('Unsafe build cleanup path');
  await rm(resolved, { recursive: true, force: true });
}
await run(npm, ['run', 'build']);
await mkdir(stage, { recursive: true });
for (const folder of ['dist', 'dist-server', 'electron']) {
  const target = path.resolve(stage, folder);
  if (path.dirname(target) !== stage) throw new Error('Unsafe staging path');
  await rm(target, { recursive: true, force: true });
  await cp(path.join(root, folder), target, { recursive: true,
    filter: file => !['runtime-package-lock.json', 'builder.cjs', 'package.json', 'package-lock.json', 'node_modules'].includes(path.basename(file)) });
}
const dependencies = {};
for (const name of ['express', 'better-sqlite3', 'dotenv', '@huggingface/transformers', 'sharp', 'adm-zip', 'csv-parse', 'opencc-js', 'parse5']) {
  const pkg = JSON.parse(await readFile(path.join(root, 'node_modules', name, 'package.json'), 'utf8'));
  dependencies[name] = pkg.version;
}
// 12.6.2 has no Electron 41 / ABI 145 prebuild. Keep the web dependency untouched.
dependencies['better-sqlite3'] = '12.11.1';
const sourcePackage = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
await writeFile(path.join(stage, 'package.json'), JSON.stringify({ name: 'medsafe-desktop', version: sourcePackage.version, private: true,
  description: '智慧醫療助理 — 本機藥品資料查詢與核對', main: 'electron/main.cjs', type: 'module', dependencies }, null, 2));
const lock = path.join(root, 'electron/runtime-package-lock.json');
try { await access(lock); await copyFile(lock, path.join(stage, 'package-lock.json')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
// No lifecycle runs in the web app's node_modules. Prepare the ABI-specific binary only in release/app.
await run(npm, ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], stage);
await copyFile(path.join(stage, 'package-lock.json'), lock);
const electronVersion = desktopTools.version;
const abi = desktopTools.getAbi(electronVersion, 'electron');
if (abi !== '145') throw new Error('Electron ABI 已改變，請先更新並查證桌面 SQLite 預編譯版本。');
const nativeName = `better-sqlite3-v${dependencies['better-sqlite3']}-electron-v${abi}-win32-x64.tar.gz`;
const nativeFile = path.join(stage, 'node_modules/better-sqlite3/prebuilds', nativeName);
const nativeSha = 'c39adedbd49f1ab60730d36fc31735d55241218372a8d962a4fc5ed8707f54de';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
let nativeCached = false;
try { nativeCached = sha256(await readFile(nativeFile)) === nativeSha; } catch (error) { if (error.code !== 'ENOENT') throw error; }
if (!nativeCached) {
  const response = await fetch(`https://github.com/WiseLibs/better-sqlite3/releases/download/v${dependencies['better-sqlite3']}/${nativeName}`, { signal: AbortSignal.timeout(180_000) });
  if (!response.ok) throw new Error(`桌面 SQLite 下載失敗：HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (sha256(bytes) !== nativeSha) throw new Error('桌面 SQLite 官方預編譯檔雜湊不符。');
  await mkdir(path.dirname(nativeFile), { recursive: true }); await writeFile(nativeFile, bytes);
}
await run(path.join(stage, 'node_modules/prebuild-install/bin.js'), ['--runtime=electron', `--target=${electronVersion}`, '--platform=win32', '--arch=x64'], path.join(stage, 'node_modules/better-sqlite3'));

const nextSeed = path.join(release, 'seed-next'), previousSeed = path.join(release, 'seed-previous');
// Recover a previous interrupted rollback before clearing any build-owned slot.
try { await access(seed); }
catch (error) {
  if (error.code !== 'ENOENT') throw error;
  try { await moveSeedDirectory(previousSeed, seed); }
  catch (recovery) { if (recovery.code !== 'ENOENT') throw recovery; }
}
await removeBuildDirectory(nextSeed); await mkdir(path.join(nextSeed, 'vision'), { recursive: true });
try {
  const source = new Database(path.join(root, 'data/drugs.db'), { readonly: true, fileMustExist: true });
  try {
    if (source.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('sessions','messages')").all().length) throw new Error('藥品來源混入對話資料，停止打包。');
    for (const table of ['tfda_drugs', 'ddinter_pairs', 'tfda_appearances']) {
      if (!source.prepare(`SELECT count(*) count FROM ${table}`).get().count) throw new Error(`缺少藥品來源：${table}`);
    }
    await source.backup(path.join(nextSeed, 'drugs.db'));
  } finally { source.close(); }
  const clean = new Database(path.join(nextSeed, 'drugs.db'));
  try { clean.exec('DELETE FROM drug_api_cache; PRAGMA journal_mode=DELETE; VACUUM;'); }
  finally { clean.close(); }
  const vision = new Database(path.join(root, 'data/vision/index.db'), { readonly: true, fileMustExist: true });
  try { await vision.backup(path.join(nextSeed, 'vision/index.db')); } finally { vision.close(); }
  // Only public reference data. User-uploaded package photos, chats, .env and raw download archives are excluded.
  for (const name of ['images', 'models', 'ATTRIBUTION.txt', 'mirror-LICENSE.txt'])
    await cp(path.join(root, 'data/vision', name), path.join(nextSeed, 'vision', name), { recursive: true });
  const originalsRoot = path.join(root, 'data/vision/originals');
  let hasOriginals = false;
  try { await access(path.join(originalsRoot, 'index.db')); hasOriginals = true; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (hasOriginals) {
    const target = path.join(nextSeed, 'vision/originals'); await mkdir(target, { recursive: true });
    const originals = new Database(path.join(originalsRoot, 'index.db'), { readonly: true, fileMustExist: true });
    try { await originals.backup(path.join(target, 'index.db')); } finally { originals.close(); }
    await cp(path.join(originalsRoot, 'images'), path.join(target, 'images'), { recursive: true });
  }
  await mkdir(path.join(nextSeed, 'sources'));
  for (const name of ['drug-data.md', 'vision.md', '本機成分對照.md', '比賽案例展示指南.md', '桌面版.md'])
    await copyFile(path.join(root, 'docs', name), path.join(nextSeed, 'sources', name));
  const verify = [];
  async function inventory(directory) {
    for (const file of await readdir(directory, { withFileTypes: true })) {
      const full = path.join(directory, file.name);
      if (file.isSymbolicLink()) throw new Error('安裝資料不能包含符號連結。');
      if (file.isDirectory()) await inventory(full);
      else verify.push({ path: path.relative(nextSeed, full).split(path.sep).join('/'), sha256: createHash('sha256').update(await readFile(full)).digest('hex') });
    }
  }
  await inventory(nextSeed);
  await writeFile(path.join(nextSeed, 'manifest.json'), JSON.stringify({ schema: 1, preparedAt: new Date().toISOString(), verify }, null, 2));
  await removeBuildDirectory(previousSeed);
  try { await moveSeedDirectory(seed, previousSeed); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  try { await moveSeedDirectory(nextSeed, seed); }
  catch (error) {
    try { await moveSeedDirectory(previousSeed, seed); }
    catch (recovery) { if (recovery.code !== 'ENOENT') throw new AggregateError([error, recovery], '新資料包替換與舊資料還原都失敗；保留 seed-previous，請解除檔案占用後再試。'); }
    throw error;
  }
  await removeBuildDirectory(previousSeed);
} finally { await removeBuildDirectory(nextSeed); }

const builder = desktopTools.builder;
if (!args.includes('--prepare-only')) await run(builder, ['--config', 'electron/builder.cjs', '--win', '--x64', '--publish', 'never', ...(args.includes('--dir') ? ['--dir'] : [])]);
console.log('桌面資料與獨立執行環境已完成；網頁版 node_modules 未被重新編譯。');
