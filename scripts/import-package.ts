import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { openDrugDatabase } from '../server/medications/store';
import { PackageVisionService } from '../server/vision/packages';

const [productName, ...files] = process.argv.slice(2);
if (!productName || files.length < 1 || files.length > 2) throw new Error('用法：npm run vision:import-package -- "完整品名" "藥盒照片路徑" ["另一面照片路徑"]');
const db = openDrugDatabase();
try {
  const service = new PackageVisionService(db);
  const result = await service.register(await Promise.all(files.map(file => readFile(file))), productName,
    '本機匯入的使用者提供照片；依包裝品名連結候選，未核對許可證。照片僅供此專案本機使用，未聲明可公開散布。', new AbortController().signal);
  console.log(JSON.stringify(result, null, 2));
} finally { db.close(); }
