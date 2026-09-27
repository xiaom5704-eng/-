import { fork, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url)), require = createRequire(import.meta.url);
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
const server = fork(fileURLToPath(new URL('../server.ts', import.meta.url)), [], { execArgv: ['--import', pathToFileURL(require.resolve('tsx')).href], cwd: root,
  env: { ...env, PORT: '0', HOST: '127.0.0.1' }, stdio: ['inherit', 'inherit', 'inherit', 'ipc'], windowsHide: true });
let desktop, stopping = false;
function stop() {
  if (stopping) return; stopping = true;
  if (desktop && desktop.exitCode === null) desktop.kill();
  if (server.connected) server.send({ type: 'shutdown' }, () => {}); else server.kill();
  const timer = setTimeout(() => server.kill(), 12_000); timer.unref();
  server.once('close', () => clearTimeout(timer));
}
const timeout = setTimeout(() => { console.error('開發服務啟動逾時。'); process.exitCode = 1; stop(); }, 45_000);
server.on('message', message => {
  if (desktop || stopping || message?.type !== 'ready' || !Number.isInteger(message.port)) return;
  clearTimeout(timeout);
  desktop = spawn(require('electron'), ['.'], { cwd: root, env: { ...env, ELECTRON_DEV_URL: `http://127.0.0.1:${message.port}` }, stdio: 'inherit' });
  desktop.once('error', error => { console.error(error.message); process.exitCode = 1; stop(); });
  desktop.once('exit', code => { process.exitCode = code || 0; stop(); });
});
server.once('error', error => { console.error(error.message); process.exitCode = 1; clearTimeout(timeout); stop(); });
server.once('exit', code => { clearTimeout(timeout); if (!stopping) { process.exitCode = code || 1; stop(); } });
process.once('SIGINT', stop); process.once('SIGTERM', stop);
