import 'dotenv/config';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { getTfda, openDrugDatabase } from '../server/medications/store';
import { DrugProviders } from '../server/medications/providers';
import type { MedicationReport } from '../shared/medication';

async function main() {
  const ids = process.argv.slice(2);
  if (!ids.length || ids.length > 6) throw new Error('用法：npm run data:check-labels -- "許可證字號" [其他字號，最多六筆]');
  let db = openDrugDatabase(), requests = 0;
  try {
    const online = new DrugProviders(db, async (url, init) => { requests++; return fetch(url, init); });
    const reports: MedicationReport[] = [];
    for (const id of ids) {
      const drug = getTfda(db, id); if (!drug) throw new Error(`本機沒有字號：${id}`);
      reports.push(await online.report([drug], 'online'));
    }
    db.close(); db = openDrugDatabase();
    let offlineRequests = 0;
    const offline = new DrugProviders(db, async () => { offlineRequests++; throw new Error('Verification forbids external requests'); });
    const results = [];
    for (const [index, id] of ids.entries()) {
      const report = await offline.report([getTfda(db, id)!], 'local');
      const current = report.medications[0], previous = reports[index].medications[0];
      assert.deepEqual(current.labels, previous.labels);
      if (previous.labelLookup) {
        assert.equal(current.labelLookup?.retrievedAt, previous.labelLookup.retrievedAt);
        assert.equal(current.labelLookup?.refresh, 'not_requested');
      }
      results.push({ id, name: current.drug.name, onlineStatus: previous.labelStatus, offlineStatus: current.labelStatus,
        source: current.labelLookup, labels: current.labels.map(label => ({ id: label.id, setId: label.setId, version: label.version,
          date: label.effectiveTime, sourceUrl: label.sourceUrl, ingredients: label.ingredients, sections: label.sections.length })) });
    }
    assert.equal(offlineRequests, 0);
    const result = { checkedAt: new Date().toISOString(), reopenedDatabase: true, requests, offlineRequests, results };
    await mkdir('test-results', { recursive: true });
    await writeFile('test-results/label-reuse-check.json', JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
  } finally { db.close(); }
}
main().catch(error => { console.error(error instanceof Error ? error.message : '仿單驗證失敗'); process.exitCode = 1; });
