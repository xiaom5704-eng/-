import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export function loadDesktopTools(root = fileURLToPath(new URL('../', import.meta.url))) {
  const require = createRequire(path.join(root, 'electron/package.json'));
  try {
    return { binary: require('electron'), version: require('electron/package.json').version,
      builder: require.resolve('electron-builder/cli.js'), getAbi: require('node-abi').getAbi };
  } catch (cause) {
    throw new Error('桌面工具尚未準備完成，請先執行 npm run electron:setup。一般網頁只需 npm run dev，不需要桌面工具。', { cause });
  }
}
