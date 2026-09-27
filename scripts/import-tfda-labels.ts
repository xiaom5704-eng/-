import { config } from 'dotenv';
import { mkdir, writeFile, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { applyTfdaLabelFile } from './tfda-label-bundle';
import { downloadBounded } from './verified-download.mjs';
import { tfdaLabelDownloadUrl } from '../shared/tfda-label-index';
import { parseTfdaLabelIndex, tfdaLabelIndexLimit } from '../server/medications/tfda-label-index';

const root = fileURLToPath(new URL('../', import.meta.url));
config({ path: path.join(root, '.env'), quiet: true });
try {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== '--download')) throw new Error('用法：npm run data:import-labels（離線補入）；加 -- --download 從 TFDA 更新索引。');
  const filename = path.resolve(root, process.env.DRUG_DB_PATH || 'data/drugs.db');
  let bytes: Buffer | undefined, retrievedAt: string | undefined;
  if (args[0] === '--download') {
    bytes = await downloadBounded(tfdaLabelDownloadUrl, tfdaLabelIndexLimit, fetch, 60_000);
    retrievedAt = new Date().toISOString();
    parseTfdaLabelIndex(bytes);
    const directory = path.join(path.dirname(filename), 'raw');
    await mkdir(directory, { recursive: true });
    const archive = path.join(directory, `tfda-labels-${retrievedAt.replace(/[:.]/g, '-')}.zip`), pending = `${archive}.${randomUUID()}.partial`;
    try { await writeFile(pending, bytes, { flag: 'wx' }); await rename(pending, archive); }
    finally { await rm(pending, { force: true }); }
  }
  const result = await applyTfdaLabelFile(filename, { bytes, retrievedAt, backup: true });
  console.log(`${result.imported ? '已匯入' : '已保留既有'}仿單／外盒索引 ${result.metadata.count.toLocaleString()} 筆，取得日期 ${result.metadata.importedAt}。`);
  console.log(`匯入前備份：${result.backupPath}`);
  console.log('索引存在本機；原始文件仍需連線開啟，這次未下載 PDF 或外盒圖片。');
} catch (error) {
  console.error('仿單索引未更新。', error instanceof Error ? error.message : '請檢查資料。');
  process.exitCode = 1;
}
