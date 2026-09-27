import { createHash } from 'node:crypto';
import AdmZip from 'adm-zip';
import type { DatasetStatus, DrugCandidate } from '../../shared/medication';
import { tfdaLabelIndexUrl, validTfdaLabelUrl, type TfdaLabelIndexEntry } from '../../shared/tfda-label-index';
import type { DrugDatabase } from './store';

export const tfdaLabelIndexLimit = 20 * 1024 * 1024;
const columns = ['許可證字號', '中文品名', '英文品名', '仿單圖檔連結', '外盒圖檔連結'];
const nameKey = (s: string) => s.normalize('NFKC').trim().replace(/\s+/g, ' ').toUpperCase();
type IndexRow = Omit<TfdaLabelIndexEntry, 'retrievedAt' | 'sha256' | 'sourceUrl'>;

export function initializeTfdaLabelIndex(db: DrugDatabase) {
  db.exec('CREATE TABLE IF NOT EXISTS tfda_label_index (id TEXT PRIMARY KEY, payload TEXT NOT NULL)');
}

export function parseTfdaLabelIndex(bytes: Buffer): IndexRow[] {
  if (!bytes.length || bytes.length > tfdaLabelIndexLimit) throw new Error('TFDA 仿單索引大小無效');
  const entries = new AdmZip(bytes).getEntries();
  if (entries.length !== 1 || entries[0].isDirectory || !/\.json$/i.test(entries[0].entryName) ||
      entries[0].header.size > tfdaLabelIndexLimit) throw new Error('TFDA 仿單 ZIP 必須只含一份 JSON');
  const raw = entries[0].getData();
  if (raw.length > tfdaLabelIndexLimit) throw new Error('TFDA 仿單 JSON 過大');
  const rows: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw).replace(/^\uFEFF/, ''));
  if (!Array.isArray(rows) || !rows.length || rows.length > 100_000) throw new Error('TFDA 仿單索引沒有有效資料');
  const ids = new Set<string>();
  return rows.map(row => {
    if (!row || typeof row !== 'object' || columns.some(key => !Object.hasOwn(row, key) ||
        (typeof row[key] !== 'string' && row[key] !== null))) throw new Error('TFDA 仿單索引欄位不符');
    const value = (key: string) => (row[key] || '').trim() as string;
    const licenseId = value('許可證字號'), name = value('中文品名') || value('英文品名'), englishName = value('英文品名');
    if (!/^(?:內衛|衛署|衛部)[\p{Script=Han}]{2,6}字第(?:\d{6}|R\d{5})號$/u.test(licenseId) || !name || name.length > 1000 || englishName.length > 1000 || ids.has(licenseId))
      throw new Error('TFDA 仿單索引許可證、品名無效或重複');
    ids.add(licenseId);
    let unavailableLabelLinks = 0;
    const links = (key: string, kind: 'label' | 'package') => {
      const urls = [...new Set(value(key).split(/;+/).map(s => s.trim()).filter(Boolean))].filter(url => {
        // The official export contains this incomplete placeholder for 12 items.
        // It has no document identity; retain the gap, never present it as a file.
        if (kind === 'label' && url === 'https://mcp.fda.gov.tw/insert/pdfcase') { unavailableLabelLinks++; return false; }
        return true;
      });
      if (urls.length > 200 || urls.some(url => url.length > 2000 || !validTfdaLabelUrl(url, licenseId, kind)))
        throw new Error('TFDA 仿單索引含非預期的官方連結');
      return urls;
    };
    const labelUrls = links('仿單圖檔連結', 'label'), packageUrls = links('外盒圖檔連結', 'package');
    return { licenseId, name, englishName, labelUrls, packageUrls, unavailableLabelLinks };
  });
}

export function importTfdaLabelIndex(db: DrugDatabase, bytes: Buffer, retrievedAt: string, { onlyIfMissing = false } = {}) {
  if (!Number.isFinite(Date.parse(retrievedAt))) throw new Error('TFDA 仿單索引取得日期無效');
  const records = parseTfdaLabelIndex(bytes), sha256 = createHash('sha256').update(bytes).digest('hex');
  return db.transaction(() => {
    initializeTfdaLabelIndex(db);
    const prior = db.prepare("SELECT metadata FROM drug_datasets WHERE source='tfda_labels'").get() as { metadata: string } | undefined;
    if (prior) {
      const metadata: DatasetStatus = JSON.parse(prior.metadata);
      if (onlyIfMissing || metadata.sha256 === sha256) return { metadata, imported: false };
    } else if (onlyIfMissing && db.prepare('SELECT 1 FROM tfda_label_index LIMIT 1').get()) {
      throw new Error('已有缺少來源紀錄的仿單索引，未以內附快照覆寫');
    }
    const metadata: DatasetStatus = { source: 'tfda_labels', count: records.length, importedAt: retrievedAt, sourceUrl: tfdaLabelIndexUrl,
      license: '政府資料開放授權條款第 1 版', sha256,
      coverage: 'TFDA 仿單／外盒連結索引；依許可證及完整中英文品名核對。僅保存入口，開啟文件需連線；不是全文下載或內容審核。取得日期不是仿單修訂日期。' };
    db.exec('DELETE FROM tfda_label_index');
    const put = db.prepare('INSERT INTO tfda_label_index VALUES(?,?)');
    for (const record of records) put.run(record.licenseId, JSON.stringify({ ...record, retrievedAt, sha256, sourceUrl: tfdaLabelIndexUrl }));
    db.prepare('INSERT OR REPLACE INTO drug_datasets VALUES(?,?)').run(metadata.source, JSON.stringify(metadata));
    return { metadata, imported: true };
  }).immediate();
}

export function readTfdaLabelIndex(db: DrugDatabase, drug: DrugCandidate): TfdaLabelIndexEntry | undefined {
  if (drug.source !== 'tfda' || drug.appearanceOnly) return;
  const row = db.prepare('SELECT payload FROM tfda_label_index WHERE id=?').get(drug.id) as { payload: string } | undefined;
  if (!row) return;
  try {
    const entry: TfdaLabelIndexEntry = JSON.parse(row.payload);
    if (entry.licenseId !== drug.id || typeof entry.name !== 'string' || typeof entry.englishName !== 'string' ||
        nameKey(entry.name) !== nameKey(drug.name) || nameKey(entry.englishName) !== nameKey(drug.englishName) ||
        entry.sourceUrl !== tfdaLabelIndexUrl || !Number.isFinite(Date.parse(entry.retrievedAt)) || !/^[a-f0-9]{64}$/.test(entry.sha256) ||
        !Array.isArray(entry.labelUrls) || !Array.isArray(entry.packageUrls) ||
        !Number.isSafeInteger(entry.unavailableLabelLinks) || entry.unavailableLabelLinks < 0 ||
        !entry.labelUrls.every(url => typeof url === 'string' && validTfdaLabelUrl(url, drug.id, 'label')) ||
        !entry.packageUrls.every(url => typeof url === 'string' && validTfdaLabelUrl(url, drug.id, 'package'))) return;
    return entry;
  } catch { return; }
}
