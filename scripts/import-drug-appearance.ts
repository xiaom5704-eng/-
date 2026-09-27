import 'dotenv/config';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { openDrugDatabase } from '../server/medications/store';
import { importAppearance } from '../server/medications/appearance';

async function main() {
  const filename = process.argv[2];
  if (!filename) throw new Error('用法：npm run data:import-appearance -- "CSV 或 ZIP 路徑"');
  const data = await readFile(path.resolve(filename));
  const db = openDrugDatabase();
  try {
    const result = importAppearance(db, data, path.basename(filename));
    await mkdir('data/raw', { recursive: true });
    await writeFile(path.join('data/raw', `${result.sha256}-${path.basename(filename)}`), data);
    const linked = db.prepare('SELECT COUNT(*) AS count FROM tfda_appearances a JOIN tfda_drugs d ON a.id = d.id').get() as { count: number };
    console.log(JSON.stringify({ ...result, linkedLicenses: linked.count, appearanceOnly: result.count - linked.count }, null, 2));
  } finally { db.close(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
