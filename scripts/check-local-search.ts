import 'dotenv/config';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import Database from 'better-sqlite3';
import { openDrugDatabase, searchLocalCandidates } from '../server/medications/store';

const filename = process.env.DRUG_DB_PATH || 'data/drugs.db';
function sourceFingerprint(db: Database.Database) {
  const hash = createHash('sha256');
  for (const table of ['tfda_drugs', 'tfda_appearances', 'ingredient_registry']) {
    hash.update(table);
    for (const row of db.prepare(`SELECT * FROM ${table} ORDER BY 1`).iterate()) hash.update(JSON.stringify(row));
  }
  return hash.digest('hex');
}
async function main() {
  const existing = new Database(filename, { readonly: true, fileMustExist: true });
  const before = sourceFingerprint(existing);
  const previousIndex = existing.prepare('SELECT version,revision FROM drug_search_meta WHERE id=1').get();
  existing.close();
  const start = performance.now();
  const db = openDrugDatabase(filename);
  const openMs = performance.now() - start;
  try {
    assert.equal(sourceFingerprint(db), before, '搜尋索引移轉不可改動藥品、外觀或成分核對紀錄');
    const queries = ['KBT', '普拿疼 加強', 'SOMIN', 'acetaminophen', '衛署藥製字第027569號', '加強锭', '伏冒 普拿疼 加強锭'];
    const results = queries.map(query => {
      const started = performance.now();
      const result = searchLocalCandidates(db, query);
      assert.ok(result.total > 0, `${query} 應有本機紀錄`);
      return { query, total: result.total, ms: Math.round(performance.now() - started), firstIds: result.candidates.slice(0, 3).map(drug => drug.id) };
    });
    const first = searchLocalCandidates(db, 'acetaminophen');
    const ids = new Set<string>();
    const allStarted = performance.now();
    for (let offset = 0; offset < first.total; offset += first.page.limit) {
      const result = searchLocalCandidates(db, 'acetaminophen', undefined, { offset, revision: first.page.revision });
      assert.equal(result.total, first.total);
      for (const drug of result.candidates) { assert.ok(!ids.has(drug.id), `分頁不應重複 ${drug.id}`); ids.add(drug.id); }
    }
    assert.equal(ids.size, first.total, '每一筆候選都能翻頁取得');
    const report = { checkedAt: new Date().toISOString(), sourceFingerprint: before, sourcePreserved: true,
      previousIndex, currentIndex: db.prepare('SELECT version,revision FROM drug_search_meta WHERE id=1').get(), openMs: Math.round(openMs), results,
      pagination: { query: 'acetaminophen', expected: first.total, unique: ids.size, pages: Math.ceil(first.total / first.page.limit), ms: Math.round(performance.now() - allStarted) } };
    await mkdir('data/reports', { recursive: true });
    const output = `data/reports/local-search-check-${Date.now()}.json`;
    await writeFile(output, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ...report, output }, null, 2));
  } finally { db.close(); }
}
main().catch(error => { console.error(error instanceof Error ? error.message : '本機搜尋檢查失敗'); process.exitCode = 1; });
