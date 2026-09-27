const { app, BrowserWindow, dialog, shell, session } = require('electron');
const path = require('node:path');
const { mkdir, writeFile } = require('node:fs/promises');
const { prepareDesktopData, startBackend } = require('./backend.cjs');

const smoke = process.argv.includes('--medsafe-smoke');
if (smoke) {
  const index = process.argv.indexOf('--user-data');
  if (index < 0 || !path.isAbsolute(process.argv[index + 1] || '')) throw new Error('Smoke verification requires an explicit absolute user-data directory.');
  app.setPath('userData', process.argv[index + 1]);
}
app.setName('MedSafe');
let mainWindow, backend, origin, quitting = false;
const originOf = value => { try { return new URL(value).origin; } catch { return ''; } };
function openReference(value) {
  try { const url = new URL(value); if (url.protocol === 'https:' && !url.username && !url.password) void shell.openExternal(url.href); } catch { /* reject malformed links */ }
}

function createWindow(loading = false) {
  mainWindow = new BrowserWindow({ width: 1280, height: 850, minWidth: 750, minHeight: 600, title: '智慧醫療助理',
    icon: path.join(app.getAppPath(), 'dist/favicon.ico'), show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
  });
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.webContents.setWindowOpenHandler(({ url }) => { openReference(url); return { action: 'deny' }; });
  mainWindow.webContents.on('will-navigate', (event, url) => { if (originOf(url) !== origin) { event.preventDefault(); openReference(url); } });
  mainWindow.on('closed', () => { mainWindow = undefined; });
  const navigation = loading ? mainWindow.loadFile(path.join(__dirname, 'loading.html')) : mainWindow.loadURL(origin);
  navigation.catch(() => { dialog.showErrorBox('介面載入失敗', '本機服務或介面檔案無法讀取，請重新啟動應用程式。'); app.quit(); });
}

async function main() {
  const appRoot = app.getAppPath(), userData = app.getPath('userData');
  if (app.isPackaged || smoke) {
    if (!smoke) createWindow(true);
    const seed = app.isPackaged ? path.join(process.resourcesPath, 'medsafe-data') : path.join(appRoot, '..', 'seed');
    const paths = await prepareDesktopData(seed, userData);
    backend = await startBackend({ appRoot, paths, electron: true, onExit: () => {
      if (backend && !quitting) { if (!smoke) dialog.showErrorBox('本機服務已停止', '請重新啟動應用程式。已保存的對話與藥品資料仍保留。'); app.quit(); }
    } });
    origin = backend.origin;
    if (smoke) {
      const page = await fetch(origin);
      const vision = await (await fetch(`${origin}/api/medications/vision/status`)).json();
      if (!page.ok || !vision.ready) throw new Error('桌面版資源檢查失敗。');
      await writeFile(path.join(userData, 'desktop-ready.json'), JSON.stringify({ checkedAt: new Date().toISOString(), origin,
        health: backend.health, vision, userData, runtime: process.versions, backendPid: backend.child.pid }, null, 2));
      const { existsSync } = require('node:fs');
      const timer = setInterval(() => { if (existsSync(path.join(userData, 'stop-desktop-check'))) { clearInterval(timer); app.quit(); } }, 250);
      setTimeout(() => app.quit(), 300_000).unref();
      return;
    }
  } else {
    const url = new URL(process.env.ELECTRON_DEV_URL || 'http://localhost:3000');
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.protocol !== 'http:') throw new Error('開發介面只接受本機 HTTP 網址。');
    origin = url.origin;
  }
  const mediaGranted = new Set();
  session.defaultSession.setPermissionCheckHandler((contents, permission, requestingOrigin, details) =>
    permission === 'media' && originOf(requestingOrigin) === origin && originOf(contents?.getURL()) === origin && mediaGranted.has(details.mediaType));
  session.defaultSession.setPermissionRequestHandler(async (contents, permission, callback, details) => {
    if (permission !== 'media' || originOf(contents.getURL()) !== origin || !details.mediaTypes?.length) { callback(false); return; }
    const types = details.mediaTypes;
    const result = await dialog.showMessageBox(mainWindow, { type: 'question', buttons: ['允許', '取消'], defaultId: 1, cancelId: 1,
      title: '裝置使用權限', message: `允許智慧醫療助理使用${types.map(type => type === 'video' ? '相機' : '麥克風').join('與')}？` });
    if (result.response === 0) types.forEach(type => mediaGranted.add(type));
    callback(result.response === 0);
  });
  if (mainWindow) await mainWindow.loadURL(origin);
  else createWindow();
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); } });
  app.whenReady().then(main).catch(async error => {
    try {
      await mkdir(app.getPath('userData'), { recursive: true });
      await writeFile(path.join(app.getPath('userData'), 'startup-error.log'), `${error.message}\n${error.details || ''}`);
    } catch { /* Still show the original startup failure when the profile is not writable. */ }
    if (!smoke) dialog.showErrorBox('智慧醫療助理無法啟動', `${error.message}\n請保留資料並查看 startup-error.log。`);
    process.exitCode = 1; app.quit();
  });
}
app.on('activate', () => { if (!smoke && origin && !mainWindow) createWindow(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', event => {
  if (backend && !quitting) { event.preventDefault(); quitting = true; void backend.stop().finally(() => app.quit()); }
});
