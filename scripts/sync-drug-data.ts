import 'dotenv/config';
import { openDrugDatabase } from '../server/medications/store';
import { syncDrugData } from './drug-data-snapshot';

async function main() {
  const db = openDrugDatabase();
  try {
    const statuses = await syncDrugData(db, { directory: 'data/raw', offline: process.argv.includes('--offline'), log: console.log });
    for (const status of statuses) console.log(`${status.source}: ${status.count} 筆，匯入時間 ${status.importedAt}`);
  } finally { db.close(); }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
