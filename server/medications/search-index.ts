import type { DrugDatabase } from './store';
import OpenCC from 'opencc-js/t2cn';
import { splitSearchMeasurements } from './search-measurements';

export interface SearchPageOptions { offset?: number; revision?: string }
const VERSION = 4;
const candidateScript = OpenCC.Converter({ from: 'tw', to: 'cn' });

// Candidate retrieval only. Preserve decimal numbers, percentages and literal
// wildcard characters. Fold Chinese script only in candidate keys, never in
// canonical drug data, ingredient identity, package registration or pill imprints.
export function searchKey(value: string): string {
  const normalized = value.normalize('NFKC');
  const script = /\p{Script=Han}/u.test(normalized) ? candidateScript(normalized) : normalized;
  return script.toLowerCase().replace(/(?<=\d)\.(?=\d)/g, '\u0001').replace(/(?<=\d),(?=\d)/g, '\u0002')
    .replace(/[^\p{L}\p{N}%_\u0001\u0002]/gu, '').replaceAll('\u0001', '.').replaceAll('\u0002', ',');
}
export const searchWords = (value: string) => value.normalize('NFKC').toLowerCase().trim().replace(/["'「」『』“”]/g, '').replace(/\s+/g, ' ');
export const searchTokens = (query: string) => [...new Set(query.trim().split(/\s+/).map(searchKey).filter(Boolean))];
export const escapeLike = (value: string) => value.replace(/[\\%_]/g, '\\$&');

interface SearchDocument { id: string; name: string; englishName: string; ingredients?: string[]; manufacturer?: string; dosageForm?: string }
function insertDocuments(db: DrugDatabase, source: string, documents: Iterable<SearchDocument>) {
  const put = db.prepare('INSERT INTO drug_search(id,source,search_key,name_key,english_key,english_words,license_key,measurement_key) VALUES(?,?,?,?,?,?,?,?)');
  for (const item of documents) put.run(item.id, source,
    [item.id, item.name, item.englishName, ...(item.ingredients || []), item.manufacturer || '', item.dosageForm || ''].map(searchKey).filter(Boolean).join(' '),
    searchKey(item.name), searchKey(item.englishName), searchWords(item.englishName), searchKey(item.id),
    `|${[...new Set([item.name, item.englishName].flatMap(name => splitSearchMeasurements(name).measurements))].join('|')}|`);
}

export function initializeSearchIndex(db: DrugDatabase) {
  db.exec(`CREATE TABLE IF NOT EXISTS drug_search (
    id TEXT NOT NULL, source TEXT NOT NULL, search_key TEXT NOT NULL, name_key TEXT NOT NULL,
    english_key TEXT NOT NULL, english_words TEXT NOT NULL, license_key TEXT NOT NULL, PRIMARY KEY(id,source));
    CREATE TABLE IF NOT EXISTS drug_search_meta (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL, revision INTEGER NOT NULL);
    INSERT OR IGNORE INTO drug_search_meta VALUES(1,0,0);`);
  db.transaction(() => {
    if (!(db.pragma('table_info(drug_search)') as { name: string }[]).some(column => column.name === 'measurement_key')) {
      db.exec("ALTER TABLE drug_search ADD COLUMN measurement_key TEXT NOT NULL DEFAULT ''");
    }
    const row = db.prepare('SELECT version FROM drug_search_meta WHERE id=1').get() as { version: number };
    if (row.version === VERSION) return;
    db.prepare('DELETE FROM drug_search').run();
    const drugs = db.prepare('SELECT payload FROM tfda_drugs').all() as { payload: string }[];
    insertDocuments(db, 'tfda', drugs.map(row => JSON.parse(row.payload)));
    const appearances = db.prepare('SELECT id,name,english_name AS englishName FROM tfda_appearances').all() as SearchDocument[];
    insertDocuments(db, 'appearance', appearances);
    db.prepare('UPDATE drug_search_meta SET version=?, revision=revision+1 WHERE id=1').run(VERSION);
  })();
}

// Invoked inside the source import transaction so records and search documents
// always advance together. Failed imports preserve both snapshots.
export function replaceSearchSource(db: DrugDatabase, source: 'tfda' | 'appearance', documents: Iterable<SearchDocument>) {
  db.prepare('DELETE FROM drug_search WHERE source=?').run(source);
  insertDocuments(db, source, documents);
  db.prepare('UPDATE drug_search_meta SET revision=revision+1 WHERE id=1').run();
}

export function searchRevision(db: DrugDatabase) {
  return String((db.prepare('SELECT revision FROM drug_search_meta WHERE id=1').get() as { revision: number }).revision);
}
export class SearchSnapshotChanged extends Error {
  constructor() { super('藥品資料已更新，請重新搜尋，以免翻頁時漏掉或重複品項。'); }
}
export function parsePageOptions(offset: unknown, revision: unknown): SearchPageOptions | undefined {
  if (offset !== undefined && !((typeof offset === 'string' && /^\d{1,7}$/.test(offset)) || typeof offset === 'number')) return undefined;
  const number = Number(offset ?? 0);
  if (!Number.isSafeInteger(number) || number < 0 || number > 1_000_000 ||
    (revision !== undefined && (typeof revision !== 'string' || !/^\d{1,12}$/.test(revision)))) return undefined;
  return { offset: number, ...(typeof revision === 'string' ? { revision } : {}) };
}
