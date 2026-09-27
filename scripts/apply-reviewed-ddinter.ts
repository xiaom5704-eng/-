import { config } from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyReviewedDdinterFile } from './reviewed-ddinter';

const root = fileURLToPath(new URL('../', import.meta.url));
config({ path: path.join(root, '.env'), quiet: true });
try {
  if (process.argv.length > 2) throw new Error('用法：npm run data:apply-reviewed（資料位置沿用 .env 的 DRUG_DB_PATH）。');
  const result = await applyReviewedDdinterFile(path.resolve(root, process.env.DRUG_DB_PATH || 'data/drugs.db'), { backup: true });
  console.log(`補入 ${result.addedSnapshots} 份已核對快照、${result.addedPairs.toLocaleString()} 組配對；總計 ${result.afterPairs.toLocaleString()} 組。`);
  console.log(`相同版本保留 ${result.alreadyPresent} 份；其他既有版本保留 ${result.preservedExisting} 份。未連線下載，也未替換既有快照。`);
  console.log(`補入前備份：${result.backupPath}`);
} catch (error) {
  console.error('DDInter 補充資料未完成，整批變更已取消。', error instanceof Error ? error.message : '請檢查本機資料。');
  process.exitCode = 1;
}
