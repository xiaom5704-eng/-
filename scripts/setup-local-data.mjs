import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { config } from 'dotenv';
import { installPublicData } from './install-public-data.mjs';
import { applyReviewedDdinterFile } from './reviewed-ddinter.ts';
import { applyTfdaLabelFile } from './tfda-label-bundle.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
config({ path: path.join(root, '.env'), quiet: true });
const controller = new AbortController();
const cancel = () => {
  process.exitCode = 130;
  controller.abort(new Error('已取消安裝。完整下載分段已保留，重新執行 npm run data:install 可接續。'));
};
process.once('SIGINT', cancel);
try {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length && !args[0].startsWith('--file=')) || args[0] === '--file=')
    throw new Error('用法：npm run data:install；或 npm run data:install -- --file="資料包 ZIP 路徑"。');
  if (path.resolve(root, process.env.DRUG_DB_PATH || 'data/drugs.db') !== path.join(root, 'data/drugs.db') ||
      path.resolve(root, process.env.VISION_DATA_DIR || 'data/vision') !== path.join(root, 'data/vision'))
    throw new Error('目前使用自訂資料路徑，未安裝。請沿用既有資料匯入流程，或在未設定自訂路徑的新專案安裝。');
  const installed = await installPublicData({ projectRoot: root, archivePath: args[0]?.slice('--file='.length), onProgress: console.log, signal: controller.signal,
    prepareData: async directory => {
      const result = await applyReviewedDdinterFile(path.join(directory, 'drugs.db'));
      console.log(`已核對的補充資料：新增 ${result.addedSnapshots} 份 DDInter 快照、${result.addedPairs.toLocaleString()} 組配對。`);
      const labels = await applyTfdaLabelFile(path.join(directory, 'drugs.db'));
      console.log(`本機仿單／外盒索引：${labels.metadata.count.toLocaleString()} 個品項；已保存文件可離線查看，其餘需連線開啟。`);
    } });
  console.log(`本機資料安裝完成，基本快照 ${installed.verifiedFiles.toLocaleString()} 個檔案校驗通過，並完成補入。基本快照準備日期：${installed.preparedAt}。`);
  console.log('執行 npm run dev，開啟終端機顯示的網址即可使用。不需要桌面安裝程式。');
} catch (error) {
  console.error(error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
    ? '資料包下載逾時，未安裝。請重試，或先下載 Release 的 ZIP，再用 npm run data:install -- --file="ZIP 路徑" 離線安裝。'
    : error instanceof Error ? error.message : '本機資料安裝失敗。');
  process.exitCode ||= 1;
} finally {
  process.removeListener('SIGINT', cancel);
}
