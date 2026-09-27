import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { config } from 'dotenv';
import { installPublicData } from './install-public-data.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
config({ path: path.join(root, '.env'), quiet: true });
try {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length && !args[0].startsWith('--file=')) || args[0] === '--file=')
    throw new Error('用法：npm run data:install；或 npm run data:install -- --file="資料包 ZIP 路徑"。');
  if (path.resolve(root, process.env.DRUG_DB_PATH || 'data/drugs.db') !== path.join(root, 'data/drugs.db') ||
      path.resolve(root, process.env.VISION_DATA_DIR || 'data/vision') !== path.join(root, 'data/vision'))
    throw new Error('目前使用自訂資料路徑，未安裝。請沿用既有資料匯入流程，或在未設定自訂路徑的新專案安裝。');
  const installed = await installPublicData({ projectRoot: root, archivePath: args[0]?.slice('--file='.length), onProgress: console.log });
  console.log(`本機資料安裝完成，${installed.verifiedFiles.toLocaleString()} 個檔案校驗通過。快照準備日期：${installed.preparedAt}。`);
  console.log('執行 npm run dev，開啟終端機顯示的網址即可使用。不需要桌面安裝程式。');
} catch (error) {
  console.error(error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
    ? '資料包下載逾時，未安裝。請重試，或先下載 Release 的 ZIP，再用 npm run data:install -- --file="ZIP 路徑" 離線安裝。'
    : error instanceof Error ? error.message : '本機資料安裝失敗。');
  process.exitCode = 1;
}
