import { createHash } from 'node:crypto';
import AdmZip from 'adm-zip';
import { parse } from 'csv-parse/sync';
import type { DatasetStatus, DrugAppearance, MedicationMatch, MedicationObservation } from '../../shared/medication';
import { APPEARANCE_URL, appearanceTerms, normalizeName, searchLocalCandidates, type DrugDatabase } from './store';
import { replaceSearchSource, searchRevision, type SearchPageOptions } from './search-index';
import { measurementSearchNotice } from './search-measurements';
import { dosageFormSearchNotice } from './dosage-forms';
import type { AppearanceOptions } from '../../shared/appearance-search';

export function localAppearanceOptions(db: DrugDatabase): AppearanceOptions {
  const terms = db.prepare(`SELECT kind,value FROM tfda_appearance_terms
    WHERE kind IN ('shape','color') AND EXISTS (SELECT 1 FROM tfda_appearances a WHERE a.id=tfda_appearance_terms.id)
    GROUP BY kind,value ORDER BY COUNT(*) DESC,value`).all() as { kind: string; value: string }[];
  return { shapes: terms.filter(term => term.kind === 'shape').map(term => term.value),
    colors: terms.filter(term => term.kind === 'color').map(term => term.value) };
}

const columns = ['許可證字號', '中文品名', '英文品名', '形狀', '特殊劑型', '顏色', '特殊氣味', '刻痕', '外觀尺寸', '標註一', '標註二', '外觀圖檔連結'];
const MAX_BYTES = 20 * 1024 * 1024;

export function importAppearance(db: DrugDatabase, input: Buffer, filename: string, importedAt = new Date().toISOString()) {
  if (!input.length || input.length > MAX_BYTES) throw new Error('外觀資料檔案必須介於 1 byte 與 20 MB');
  let csv = input;
  if (/\.zip$/i.test(filename)) {
    const entries = new AdmZip(input).getEntries().filter(entry => !entry.isDirectory);
    if (entries.length !== 1 || !/\.csv$/i.test(entries[0].entryName) || entries[0].header.size > MAX_BYTES) throw new Error('ZIP 必須只包含一份不超過 20 MB 的 CSV');
    // Read in memory; never extract archive paths onto disk.
    csv = entries[0].getData();
  } else if (!/\.csv$/i.test(filename)) throw new Error('請提供 .csv 或 .csv.zip 檔案');
  if (csv.length > MAX_BYTES) throw new Error('CSV 超過 20 MB');
  const rows = parse(new TextDecoder('utf-8', { fatal: true }).decode(csv), { bom: true, columns: true, skip_empty_lines: true, trim: true }) as Record<string, string>[];
  if (!rows.length || columns.some(column => !Object.hasOwn(rows[0], column))) throw new Error('外觀 CSV 欄位不符或沒有資料，保留原有資料');
  const records = new Map<string, { id: string; name: string; englishName: string; appearance: DrugAppearance }>();
  for (const row of rows) {
    const id = row['許可證字號'].trim();
    const name = row['中文品名'].trim() || row['英文品名'].trim();
    if (!id || !name || id.length > 80 || records.has(id)) throw new Error('外觀 CSV 許可證或品名缺漏、字號重複，取消匯入');
    const imageUrls = row['外觀圖檔連結'].split(/;;;|；；；/).map(value => value.trim()).filter(value => {
      try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && (url.hostname === 'fda.gov.tw' || url.hostname.endsWith('.fda.gov.tw')); } catch { return false; }
    });
    records.set(id, { id, name, englishName: row['英文品名'].trim(), appearance: {
      shape: row['形狀'], color: row['顏色'], score: row['刻痕'], size: row['外觀尺寸'],
      imprint1: row['標註一'], imprint2: row['標註二'], imageUrls, sourceUrl: APPEARANCE_URL,
    } });
  }
  const metadata: DatasetStatus = { source: 'tfda_appearance', count: records.size, importedAt, sourceUrl: APPEARANCE_URL,
    license: '政府資料開放授權條款第 1 版', fileName: filename, sha256: createHash('sha256').update(input).digest('hex'),
    coverage: '使用者匯入的 TFDA 外觀快照；依許可證字號連結藥品主檔。外觀僅供候選比對，不代表唯一識別；圖檔為外部連結，匯入時間不是來源更新日期。' };
  db.transaction(() => {
    db.exec('DELETE FROM tfda_appearance_terms; DELETE FROM tfda_appearances;');
    const put = db.prepare('INSERT INTO tfda_appearances(id,name,english_name,search_text,payload) VALUES(?,?,?,?,?)');
    const term = db.prepare('INSERT OR IGNORE INTO tfda_appearance_terms(id,kind,value) VALUES(?,?,?)');
    for (const record of records.values()) {
      put.run(record.id, record.name, record.englishName, normalizeName([record.id, record.name, record.englishName].join(' ')), JSON.stringify(record.appearance));
      for (const kind of ['shape', 'color', 'imprint'] as const) {
        const values = kind === 'imprint' ? [record.appearance.imprint1, record.appearance.imprint2] : [record.appearance[kind]];
        for (const value of values.flatMap(value => appearanceTerms(value, kind))) term.run(record.id, kind, value);
      }
    }
    replaceSearchSource(db, 'appearance', records.values());
    db.prepare('INSERT OR REPLACE INTO drug_datasets(source,metadata) VALUES(?,?)').run(metadata.source, JSON.stringify(metadata));
  })();
  return metadata;
}

export function validObservations(value: unknown): value is MedicationObservation[] {
  if (!Array.isArray(value) || !value.length || value.length > 6) return false;
  const text = (input: unknown) => typeof input === 'string' && input.length <= 120;
  return value.every(item => item && text(item.name) && text(item.strength) && text(item.dosageForm) &&
    (!item.appearance || (text(item.appearance.shape) && text(item.appearance.color) && Array.isArray(item.appearance.imprints) &&
      item.appearance.imprints.length <= 2 && item.appearance.imprints.every(text))));
}

export function matchObservation(db: DrugDatabase, observation: MedicationObservation, options: SearchPageOptions = {}): MedicationMatch {
  const name = observation.name.trim(), a = observation.appearance;
  const hasAppearance = a && (a.imprints.some(value => value.trim()) || (a.shape.trim() && a.color.trim()));
  if (name.length < 2 && !hasAppearance) return { observation, candidates: [], total: 0, matchedBy: 'insufficient',
    page: { offset: 0, limit: 20, total: 0, hasMore: false, revision: searchRevision(db) },
    warnings: ['辨識特徵不足，請補充清楚的藥名、刻字，或同時提供顏色與形狀。'] };
  const query = [name.length >= 2 ? name : '', observation.strength.trim()].filter(Boolean).join(' ');
  const result = searchLocalCandidates(db, query, a, { ...options, dosageForm: observation.dosageForm });
  const warnings = ['候選結果需核對品名、規格及外觀；相似外觀不能直接確認藥品身分。', ...measurementSearchNotice(query), ...dosageFormSearchNotice(db, observation.dosageForm)];
  if (name.length >= 2) warnings.push('藥名搜尋會合併簡繁字形，回傳品名保留資料庫原文；誤字、規格與刻字仍須人工核對。');
  if (!result.total) warnings.push('本機資料沒有符合的候選；請核對辨識文字或補拍清楚的正反面，不會自動改查線上 API。');
  if (result.total > 20) warnings.push(`共有 ${result.total} 個候選，可翻頁查看，也可補充刻字或完整藥名縮小範圍。`);
  return { observation, ...result, matchedBy: name.length >= 2 ? 'name' : 'appearance', warnings };
}
