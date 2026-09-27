import 'dotenv/config';
import { mkdir, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { DrugProviders, ingredientLookup } from '../server/medications/providers';
import { readIngredientRecord } from '../server/medications/ingredient-registry';
import { getTfda, openDrugDatabase } from '../server/medications/store';
import { caseProducts } from '../shared/medication-safety';
import type { DrugCandidate } from '../shared/medication';

async function main() {
  const args = process.argv.slice(2);
  if (args.some(arg => !['--audit', '--case', '--missing'].includes(arg) && !/^--limit=\d+$/.test(arg))) throw new Error('用法：npm run data:enrich -- [--limit=100] [--case] [--audit] [--missing]');
  const limit = Number(args.find(arg => arg.startsWith('--limit='))?.split('=')[1] ?? 100);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10000) throw new Error('limit 請填 1–10000');
  const db = openDrugDatabase();
  try {
    const products: DrugCandidate[] = args.includes('--case') ? caseProducts.map(spec => getTfda(db, spec.id)).filter(Boolean) :
      (db.prepare('SELECT payload FROM tfda_drugs WHERE active=1').all() as { payload: string }[]).map(row => JSON.parse(row.payload));
    if (!products.length) throw new Error('沒有可核對的本機品項，請先匯入 TFDA 資料');
    const entries = new Map<string, { key: string; original: string; drug: DrugCandidate; count: number }>();
    for (const drug of products) for (const original of new Set(drug.ingredients)) {
      const { key } = ingredientLookup(original, drug);
      const entry = entries.get(key);
      if (entry) entry.count++; else entries.set(key, { key, original, drug, count: 1 });
    }
    // At most five sequential network requests per second, comfortably below
    // NLM's per-IP limit. Only public ingredient names/IDs leave the machine.
    let lastRequest = 0, requests = 0;
    const providers = new DrugProviders(db, async (url, init) => {
      await delay(Math.max(0, 200 - (Date.now() - lastRequest)));
      lastRequest = Date.now(); requests++;
      return fetch(url, init);
    });
    const audit = async () => {
      let ddinter = 0, rxnorm = 0, reviewed = 0;
      for (const entry of entries.values()) {
        const item = (await providers.resolveIngredient(entry.original, entry.drug, 'local'))[0];
        if (item.ddinterId) ddinter++;
        if (item.rxCui) rxnorm++;
        if (readIngredientRecord(db, entry.key)) reviewed++;
      }
      return { products: products.length, ingredientContexts: entries.size, ddinterMatched: ddinter, rxnormMatched: rxnorm, reviewed, unresolvedDdinter: entries.size - ddinter };
    };
    const before = await audit();
    console.log(JSON.stringify({ before }));
    let processed = 0, failures = 0, consecutiveFailures = 0;
    if (!args.includes('--audit')) {
      const pending = [...entries.values()].filter(entry => {
        const record = readIngredientRecord(db, entry.key);
        return !record || (!args.includes('--missing') && Date.now() - Date.parse(record.checkedAt) >= 24 * 60 * 60 * 1000);
      }).sort((a, b) => b.count - a.count).slice(0, limit);
      for (const entry of pending) {
        const previous = readIngredientRecord(db, entry.key)?.checkedAt;
        await providers.resolveIngredient(entry.original, entry.drug, 'online');
        const record = readIngredientRecord(db, entry.key);
        processed++;
        if (!record || record.checkedAt === previous) { failures++; consecutiveFailures++; } else consecutiveFailures = 0;
        if (processed % 10 === 0 || processed === pending.length || consecutiveFailures >= 3) console.log(JSON.stringify({ processed, total: pending.length, failures, requests }));
        if (consecutiveFailures >= 3) { console.error('連續三筆未完成查核，停止批次；已保存紀錄保留，下次可續做。'); break; }
      }
    }
    const report = { checkedAt: new Date().toISOString(), scope: args.includes('--case') ? 'demo' : 'active_tfda', before, after: await audit(), processed, failures, requests,
      note: '統計以原始名稱及核對依據範圍去重；不是藥品識別正確率或完整臨床覆蓋率。DDInter 未收錄或精確名稱無法對照者保留未知。' };
    await mkdir('data/reports', { recursive: true });
    const filename = `data/reports/ingredient-coverage-${report.scope}-${Date.now()}.json`;
    await writeFile(filename, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ...report, reportFile: filename }, null, 2));
    if (failures) process.exitCode = 2;
  } finally { db.close(); }
}
main().catch(error => { console.error(error instanceof Error ? error.message : '成分核對失敗'); process.exitCode = 1; });
