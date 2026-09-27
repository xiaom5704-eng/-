import { parse } from 'csv-parse/sync';
import type { DatasetStatus, DrugCandidate } from '../../shared/medication';
import { DDINTER_URL, TFDA_URL, normalizeName, type DrugDatabase } from './store';
import { replaceSearchSource } from './search-index';
import { assertDdinterConsistency } from './ddinter-supplements';

export function importTfda(db: DrugDatabase, input: unknown, importedAt = new Date().toISOString()) {
  if (!Array.isArray(input) || !input.length) throw new Error('TFDA 資料必須是非空 JSON 陣列');
  const records = new Map<string, DrugCandidate>();
  for (const row of input) {
    if (!row || typeof row['許可證字號'] !== 'string' || !('中文品名' in row) || !('主成分略述' in row)) {
      throw new Error('TFDA 資料欄位不符；保留原有資料');
    }
    const str = (key: string) => String(row[key] || '').trim();
    const id = str('許可證字號');
    if (!id || !(str('中文品名') || str('英文品名'))) throw new Error('TFDA 許可證或品名缺漏');
    records.set(id, {
      source: 'tfda', id, name: str('中文品名') || str('英文品名'), englishName: str('英文品名'),
      ingredients: [...new Set(str('主成分略述').split(/;;|；；/).map(s => s.trim()).filter(Boolean))],
      dosageForm: str('劑型'), manufacturer: str('申請商名稱'), licenseStatus: str('註銷狀態') || '未標示註銷',
      validUntil: str('有效日期'), indications: str('適應症'), dosageText: str('用法用量'), sourceUrl: TFDA_URL,
    });
  }
  const metadata: DatasetStatus = { source: 'tfda', count: records.size, importedAt, sourceUrl: TFDA_URL,
    license: '政府資料開放授權條款第 1 版', coverage: '全部藥品許可證快照，含已註銷及過期資料；匯入時間不等於原始資料更新時間' };
  db.transaction(() => {
    db.prepare('DELETE FROM tfda_drugs').run();
    const put = db.prepare('INSERT INTO tfda_drugs(id,name,english_name,search_text,active,payload) VALUES(?,?,?,?,?,?)');
    for (const item of records.values()) put.run(item.id, item.name, item.englishName,
      normalizeName([item.id, item.name, item.englishName, ...item.ingredients].join(' ')),
      item.licenseStatus === '未標示註銷' ? 1 : 0, JSON.stringify(item));
    replaceSearchSource(db, 'tfda', records.values());
    db.prepare('INSERT OR REPLACE INTO drug_datasets(source,metadata) VALUES(?,?)').run('tfda', JSON.stringify(metadata));
  })();
  return metadata;
}

export function importDdinter(db: DrugDatabase, files: { name: string; csv: string }[], importedAt = new Date().toISOString()) {
  if (!files.length) throw new Error('未提供 DDInter CSV');
  const records = files.flatMap(file => {
    const rows = parse(file.csv, { columns: true, bom: true, skip_empty_lines: true, trim: true }) as Record<string, string>[];
    if (!rows.length) throw new Error(`DDInter 空資料：${file.name}`);
    for (const row of rows) {
      if (!/^DDInter\d+$/.test(row.DDInterID_A || '') || !/^DDInter\d+$/.test(row.DDInterID_B || '') ||
          !row.Drug_A || !row.Drug_B || !['Major', 'Moderate', 'Minor', 'Unknown'].includes(row.Level)) {
        throw new Error(`DDInter 欄位或風險等級無效：${file.name}；保留原有資料`);
      }
    }
    return rows;
  });
  return db.transaction(() => {
    db.prepare('DELETE FROM ddinter_pairs').run();
    db.prepare('DELETE FROM ddinter_drugs').run();
    const drug = db.prepare('INSERT OR REPLACE INTO ddinter_drugs(id,name,normalized_name) VALUES(?,?,?)');
    const pair = db.prepare('INSERT OR IGNORE INTO ddinter_pairs(drug_a,drug_b,level) VALUES(?,?,?)');
    const existing = db.prepare('SELECT level FROM ddinter_pairs WHERE drug_a = ? AND drug_b = ?');
    for (const row of records) {
      drug.run(row.DDInterID_A, row.Drug_A, normalizeName(row.Drug_A));
      drug.run(row.DDInterID_B, row.Drug_B, normalizeName(row.Drug_B));
      const [a, b] = [row.DDInterID_A, row.DDInterID_B].sort();
      const prior = existing.get(a, b) as { level: string } | undefined;
      if (prior && prior.level !== row.Level) throw new Error(`DDInter 配對等級衝突：${a}, ${b}；取消匯入`);
      pair.run(a, b, row.Level);
    }
    assertDdinterConsistency(db);
    const count = (db.prepare('SELECT COUNT(*) AS count FROM ddinter_pairs').get() as { count: number }).count;
    const metadata: DatasetStatus = { source: 'ddinter', count, importedAt, sourceUrl: DDINTER_URL,
      license: 'CC BY-NC-SA 4.0（姓名標示／非商業性／相同方式分享）',
      coverage: `DDInter 2.0 官方 CSV：${files.map(f => f.name).join(', ')}；僅含配對與風險等級，不含機制與處置全文，非完整網站資料庫` };
    db.prepare('INSERT OR REPLACE INTO drug_datasets(source,metadata) VALUES(?,?)').run('ddinter', JSON.stringify(metadata));
    return metadata;
  })();
}
