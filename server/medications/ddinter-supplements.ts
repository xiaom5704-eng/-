import { createHash } from 'node:crypto';
import { normalizeName, type DrugDatabase } from './store';

export const ddinterDrugUrl = (id: string) => `https://ddinter2.scbdd.com/server/drug-detail/${id}/`;
export const ddinterGraphUrl = (id: string) => `https://ddinter2.scbdd.com/server/grapher-datasource/${id}/`;
const validId = (value: unknown): value is string => typeof value === 'string' && /^DDInter\d+$/.test(value);
const validName = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= 300;
const levels = new Set(['Major', 'Moderate', 'Minor', 'Unknown']);

// CSV and website snapshots remain separate. Every imported graph keeps its raw
// response and provenance; replacing one graph cannot remove another source.
export function initializeDdinterSupplements(db: DrugDatabase) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ddinter_web_snapshots (id TEXT PRIMARY KEY, name TEXT NOT NULL,
      retrieved_at TEXT NOT NULL, source_url TEXT NOT NULL, data_url TEXT NOT NULL, sha256 TEXT NOT NULL, raw TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS ddinter_web_drugs (root_id TEXT NOT NULL, id TEXT NOT NULL,
      name TEXT NOT NULL, normalized_name TEXT NOT NULL, PRIMARY KEY(root_id,id));
    CREATE INDEX IF NOT EXISTS ddinter_web_names ON ddinter_web_drugs(normalized_name);
    CREATE TABLE IF NOT EXISTS ddinter_web_pairs (root_id TEXT NOT NULL, drug_a TEXT NOT NULL,
      drug_b TEXT NOT NULL, level TEXT NOT NULL, PRIMARY KEY(root_id,drug_a,drug_b));
    CREATE INDEX IF NOT EXISTS ddinter_web_pair_lookup ON ddinter_web_pairs(drug_a,drug_b);
    CREATE VIEW IF NOT EXISTS ddinter_all_drugs AS SELECT id, MIN(name) AS name, normalized_name FROM (
      SELECT id,name,normalized_name FROM ddinter_drugs UNION ALL
      SELECT id,name,normalized_name FROM ddinter_web_drugs
    ) GROUP BY id,normalized_name;
    CREATE VIEW IF NOT EXISTS ddinter_all_pairs AS SELECT drug_a,drug_b,level FROM ddinter_pairs UNION
      SELECT drug_a,drug_b,level FROM ddinter_web_pairs;
  `);
}

export function assertDdinterConsistency(db: DrugDatabase) {
  if (db.prepare('SELECT id FROM ddinter_all_drugs GROUP BY id HAVING COUNT(*) > 1 LIMIT 1').get())
    throw new Error('DDInter 來源的同一 ID 名稱不一致；保留原資料，請先核對來源。');
  if (db.prepare('SELECT drug_a FROM ddinter_all_pairs GROUP BY drug_a,drug_b HAVING COUNT(*) > 1 LIMIT 1').get())
    throw new Error('DDInter CSV 與網站快照的配對等級衝突；保留原資料，請先核對來源。');
}

export function parseDdinterGraph(raw: string, expectedId: string) {
  if (!validId(expectedId) || Buffer.byteLength(raw) > 4_000_000) throw new Error('DDInter 網站快照設定或大小無效。');
  const value = JSON.parse(raw);
  if (value?.info?.id !== expectedId || !validName(value.info.Name) || !Array.isArray(value.interactions) || value.interactions.length > 10000)
    throw new Error('DDInter 網站快照成分或格式不符。');
  const drugs = new Map<string, string>([[expectedId, value.info.Name.trim()]]);
  const pairs: { drugA: string; drugB: string; level: string }[] = [];
  for (const item of value.interactions) {
    if (!validId(item?.id) || item.id === expectedId || drugs.has(item.id) || !validName(item.name) ||
        !Array.isArray(item.level) || item.level.length !== 1 || !levels.has(item.level[0]))
      throw new Error('DDInter 網站快照含重複、矛盾或無效配對；未匯入。');
    drugs.set(item.id, item.name.trim());
    const [drugA, drugB] = [expectedId, item.id].sort();
    pairs.push({ drugA, drugB, level: item.level[0] });
  }
  return { id: expectedId, name: value.info.Name.trim() as string, drugs, pairs };
}

export function importDdinterGraph(db: DrugDatabase, raw: string, id: string, retrievedAt: string) {
  if (!/^\d{4}-\d{2}-\d{2}T/.test(retrievedAt) || !Number.isFinite(Date.parse(retrievedAt))) throw new Error('DDInter 取得時間無效。');
  const graph = parseDdinterGraph(raw, id);
  return db.transaction(() => {
    db.prepare('DELETE FROM ddinter_web_pairs WHERE root_id=?').run(id);
    db.prepare('DELETE FROM ddinter_web_drugs WHERE root_id=?').run(id);
    const drug = db.prepare('INSERT INTO ddinter_web_drugs VALUES(?,?,?,?)');
    const pair = db.prepare('INSERT INTO ddinter_web_pairs VALUES(?,?,?,?)');
    for (const [drugId, name] of graph.drugs) drug.run(id, drugId, name, normalizeName(name));
    for (const item of graph.pairs) pair.run(id, item.drugA, item.drugB, item.level);
    assertDdinterConsistency(db);
    const hash = createHash('sha256').update(raw).digest('hex');
    db.prepare('INSERT OR REPLACE INTO ddinter_web_snapshots VALUES(?,?,?,?,?,?,?)')
      .run(id, graph.name, retrievedAt, ddinterDrugUrl(id), ddinterGraphUrl(id), hash, raw);
    return { id, name: graph.name, pairs: graph.pairs.length, retrievedAt, sha256: hash };
  })();
}
