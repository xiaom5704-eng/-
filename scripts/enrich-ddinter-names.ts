import 'dotenv/config';
import { mkdir, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { DrugProviders } from '../server/medications/providers';
import { exactLookupName, ingredientRegistryKey, readIngredientRecord } from '../server/medications/ingredient-registry';
import { openDrugDatabase } from '../server/medications/store';

async function main() {
  const args = process.argv.slice(2);
  if (args.some(arg => !['--audit', '--refresh'].includes(arg) && !/^--limit=\d+$/.test(arg))) throw new Error('用法：npm run data:enrich-ddinter -- [--limit=100] [--audit] [--refresh]');
  const limit = Number(args.find(arg => arg.startsWith('--limit='))?.split('=')[1] ?? 100);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10000) throw new Error('limit 請填 1–10000');
  const db = openDrugDatabase();
  try {
    const drugs = db.prepare('SELECT id,name FROM ddinter_all_drugs ORDER BY id').all() as { id: string; name: string }[];
    if (!drugs.length) throw new Error('請先匯入 DDInter 資料');
    const recordFor = (name: string) => readIngredientRecord(db, ingredientRegistryKey([name]));
    const audit = () => {
      let reviewed = 0, exactIngredient = 0;
      for (const drug of drugs) {
        const record = recordFor(drug.name);
        if (record) reviewed++;
        if (record?.status === 'matched' && record.matched?.tty === 'IN' && record.matched.rxcui === record.ingredient?.rxcui && exactLookupName(record)) exactIngredient++;
      }
      return { ddinterNames: drugs.length, reviewed, exactIngredient, pending: drugs.length - reviewed };
    };
    const before = audit();
    let requests = 0, lastRequest = 0, processed = 0, failures = 0, consecutiveFailures = 0;
    const provider = new DrugProviders(db, async (url, init) => {
      await delay(Math.max(0, 200 - (Date.now() - lastRequest)));
      lastRequest = Date.now(); requests++;
      return fetch(url, init);
    });
    console.log(JSON.stringify({ before }));
    if (!args.includes('--audit')) {
      const pending = drugs.filter(drug => {
        const record = recordFor(drug.name);
        return !record || (args.includes('--refresh') && Date.now() - Date.parse(record.checkedAt) >= 86_400_000);
      }).slice(0, limit);
      for (const drug of pending) {
        const previous = recordFor(drug.name)?.checkedAt;
        await provider.resolveIngredient(drug.name, undefined, 'online');
        const record = recordFor(drug.name);
        processed++;
        if (!record || record.checkedAt === previous) { failures++; consecutiveFailures++; } else consecutiveFailures = 0;
        if (processed % 25 === 0 || processed === pending.length || consecutiveFailures >= 3) console.log(JSON.stringify({ processed, total: pending.length, requests, failures }));
        if (consecutiveFailures >= 3) { console.error('連續三筆未完成核對，停止批次並保留已保存紀錄。'); break; }
      }
    }
    const report = { checkedAt: new Date().toISOString(), before, after: audit(), processed, failures, requests,
      note: '只按完整 DDInter 名稱精確查詢 RxNorm。執行時仍須唯一 IN 對照且 DDInter 名稱存在於當前資料；不是臨床驗證，也不新增交互作用。' };
    await mkdir('data/reports', { recursive: true });
    const file = `data/reports/ddinter-names-${Date.now()}.json`;
    await writeFile(file, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ...report, reportFile: file }, null, 2));
    if (failures) process.exitCode = 2;
  } finally { db.close(); }
}
main().catch(error => { console.error(error instanceof Error ? error.message : 'DDInter 名稱核對失敗'); process.exitCode = 1; });
