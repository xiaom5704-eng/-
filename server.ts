import { loadRuntimeConfig } from './server/runtime';

async function main() {
  const config = loadRuntimeConfig();
  const { startApplication } = await import('./server/application');
  const server = await startApplication(config);
  console.log(`Server running on http://localhost:${server.port}`);
  process.send?.({ type: 'ready', port: server.port });
  const stop = () => { void server.close().then(() => process.exit(0), () => process.exit(1)); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  process.once('disconnect', stop);
  process.on('message', message => { if (message && typeof message === 'object' && 'type' in message && message.type === 'shutdown') stop(); });
}

main().catch(error => {
  console.error(error?.code === 'EADDRINUSE' ? '服務啟動失敗：連線埠已被使用，請停止舊服務或設定其他 PORT。' : `服務啟動失敗：${error instanceof Error ? error.message : '請檢查設定與資料庫。'}`);
  process.exitCode = 1;
});
