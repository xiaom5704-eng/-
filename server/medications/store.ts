import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { DatasetStatus, DrugAppearance, DrugCandidate, InteractionEvidence, MedicationEvidence, MedicationObservation } from '../../shared/medication';
import { escapeLike, initializeSearchIndex, searchKey, searchRevision, searchTokens, searchWords, SearchSnapshotChanged, type SearchPageOptions } from './search-index';
import { splitSearchMeasurements } from './search-measurements';
import { resolveDosageForm } from './dosage-forms';
import { initializeDdinterSupplements } from './ddinter-supplements';
import { initializeDdinterDetails, readDdinterDetail } from './ddinter-details';
import { initializeSourceDocuments } from './source-documents';
import { initializeTfdaLabelIndex } from './tfda-label-index';
import { initializeTfdaDocuments } from './tfda-documents';
import { tfdaLabelIndexUrl } from '../../shared/tfda-label-index';
import { createDdinterMechanismReader } from './ddinter-mechanisms';
import { appearanceTerms } from '../../shared/appearance-search';
import { findImprintMatches } from './imprint-search';
export { appearanceTerms } from '../../shared/appearance-search';

export const TFDA_URL = 'https://data.gov.tw/dataset/9122';
export const DDINTER_URL = 'https://ddinter2.scbdd.com/download/';
export const APPEARANCE_URL = 'https://data.gov.tw/dataset/9120';
export const normalizeName = (name: string) => name.normalize('NFKC').toLowerCase().trim().replace(/\s+/g, ' ');

export function openDrugDatabase(filename = process.env.DRUG_DB_PATH || 'data/drugs.db') {
  if (filename !== ':memory:') mkdirSync(path.dirname(path.resolve(filename)), { recursive: true });
  const db = new Database(filename);
  try {
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.exec(`
    CREATE TABLE IF NOT EXISTS drug_datasets (source TEXT PRIMARY KEY, metadata TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS tfda_drugs (id TEXT PRIMARY KEY, name TEXT NOT NULL, english_name TEXT NOT NULL,
      search_text TEXT NOT NULL, active INTEGER NOT NULL, payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS ddinter_drugs (id TEXT PRIMARY KEY, name TEXT NOT NULL, normalized_name TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS ddinter_names ON ddinter_drugs(normalized_name);
    CREATE TABLE IF NOT EXISTS ddinter_pairs (drug_a TEXT NOT NULL, drug_b TEXT NOT NULL, level TEXT NOT NULL,
      PRIMARY KEY(drug_a, drug_b));
    CREATE TABLE IF NOT EXISTS drug_api_cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS ingredient_registry (key TEXT PRIMARY KEY, payload TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS ingredient_registry_rxcui ON ingredient_registry(json_extract(payload, '$.ingredient.rxcui')) WHERE json_valid(payload);
    CREATE TABLE IF NOT EXISTS label_registry (key TEXT PRIMARY KEY, payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS tfda_appearances (id TEXT PRIMARY KEY, name TEXT NOT NULL, english_name TEXT NOT NULL,
      search_text TEXT NOT NULL, payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS tfda_appearance_terms (id TEXT NOT NULL, kind TEXT NOT NULL, value TEXT NOT NULL,
      PRIMARY KEY(id, kind, value));
    CREATE INDEX IF NOT EXISTS appearance_terms_lookup ON tfda_appearance_terms(kind, value, id);
  `);
  if (!(db.pragma('table_info(drug_api_cache)') as { name: string }[]).some(column => column.name === 'retrieved_at')) {
    db.exec('ALTER TABLE drug_api_cache ADD COLUMN retrieved_at INTEGER');
  }
  initializeDdinterSupplements(db);
  initializeDdinterDetails(db);
  initializeSourceDocuments(db);
  initializeTfdaLabelIndex(db);
  initializeTfdaDocuments(db);
  initializeSearchIndex(db);
  return db;
  } catch (error) { db.close(); throw error; }
}

export type DrugDatabase = ReturnType<typeof openDrugDatabase>;

export function datasetStatus(db: DrugDatabase): DatasetStatus[] {
  return (['tfda', 'ddinter', 'tfda_appearance', 'tfda_labels'] as const).map(source => {
    const row = db.prepare('SELECT metadata FROM drug_datasets WHERE source = ?').get(source) as { metadata: string } | undefined;
    const status: DatasetStatus = row ? JSON.parse(row.metadata) : {
      source, count: 0, importedAt: null,
      sourceUrl: source === 'tfda' ? TFDA_URL : source === 'tfda_appearance' ? APPEARANCE_URL : source === 'tfda_labels' ? tfdaLabelIndexUrl : DDINTER_URL,
      license: source === 'ddinter' ? 'CC BY-NC-SA 4.0' : '政府資料開放授權條款第 1 版',
      coverage: '尚未匯入',
    };
    if (source === 'ddinter') {
      const snapshots = db.prepare('SELECT COUNT(*) AS count, MAX(retrieved_at) AS latest FROM ddinter_web_snapshots').get() as { count: number; latest: string | null };
      if (snapshots.count) {
        status.count = (db.prepare('SELECT COUNT(*) AS count FROM ddinter_all_pairs').get() as { count: number }).count;
        if (!row) { status.coverage = '尚未匯入 CSV'; status.importedAt = snapshots.latest; }
        status.coverage += `；另含 ${snapshots.count} 份官方成分頁的本機配對快照，最近取得 ${snapshots.latest}，仍非完整網站資料庫`;
      }
    }
    return status;
  });
}

export function searchTfda(db: DrugDatabase, query: string): DrugCandidate[] {
  return searchLocalCandidates(db, query).candidates;
}

export function searchLocalCandidates(db: DrugDatabase, query: string, appearance?: MedicationObservation['appearance'], options: SearchPageOptions & { dosageForm?: string } = {}) {
  const offset = options.offset ?? 0, limit = 20, revision = searchRevision(db);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1_000_000) throw new Error('搜尋分頁無效');
  if (options.revision !== undefined && options.revision !== revision) throw new SearchSnapshotChanged();
  const page = (total: number) => ({ offset, limit, total, hasMore: offset + limit < total, revision });
  const conditions: string[] = [], values: string[] = [];
  let seed = '';
  if (query.trim()) {
    const { text, measurements } = splitSearchMeasurements(query);
    const tokens = searchTokens(text);
    if (!tokens.length && !measurements.length) return { candidates: [], total: 0, page: page(0) };
    seed = `SELECT id, MIN(CASE WHEN license_key=? THEN 0 WHEN name_key=? OR english_key=? THEN 1
      WHEN english_words LIKE ? ESCAPE '\\' THEN 2 ELSE 3 END) AS rank FROM drug_search WHERE
      ${tokens.length ? tokens.map(() => "search_key LIKE ? ESCAPE '\\'").join(' AND ') : '1=1'} GROUP BY id`;
    const key = searchKey(query);
    values.push(key, key, key, `${escapeLike(searchWords(query))} %`, ...tokens.map(token => `%${escapeLike(token)}%`));
    if (measurements.length) {
      // Use the current product name when present. An older appearance name or
      // numbers in a license/manufacturer must not satisfy a stated strength.
      conditions.push(`EXISTS (SELECT 1 FROM drug_search specs WHERE specs.id=ids.id
        AND specs.source=CASE WHEN EXISTS (SELECT 1 FROM tfda_drugs WHERE id=ids.id) THEN 'tfda' ELSE 'appearance' END
        AND ${measurements.map(() => "specs.measurement_key LIKE ? ESCAPE '\\'").join(' AND ')})`);
      values.push(...measurements.map(value => `%|${escapeLike(value)}|%`));
    }
  }
  if (appearance) {
    for (const input of appearance.imprints.filter(value => value.trim())) {
      const matches = findImprintMatches(db, input);
      if (!matches.length) return { candidates: [], total: 0, page: page(0) };
      if (!seed) seed = "SELECT json_extract(value,'$.id') AS id,json_extract(value,'$.rank') AS rank FROM json_each(?)";
      else conditions.push("ids.id IN (SELECT json_extract(value,'$.id') FROM json_each(?))");
      values.push(JSON.stringify(matches));
    }
    const filters = [
      ...appearanceTerms(appearance.shape, 'shape').map(value => ['shape', value]),
      ...appearanceTerms(appearance.color, 'color').map(value => ['color', value]),
    ];
    for (const [kind, value] of filters) {
      if (!seed) seed = 'SELECT id, 3 AS rank FROM tfda_appearance_terms WHERE kind = ? AND value = ?';
      else conditions.push('EXISTS (SELECT 1 FROM tfda_appearance_terms t WHERE t.id = ids.id AND t.kind = ? AND t.value = ?)');
      values.push(kind, value);
    }
  }
  if (options.dosageForm?.trim()) {
    const forms = resolveDosageForm(db, options.dosageForm);
    if (!forms.length) return { candidates: [], total: 0, page: page(0) };
    conditions.push(`EXISTS (SELECT 1 FROM tfda_drugs form WHERE form.id=ids.id AND json_extract(form.payload,'$.dosageForm') IN (${forms.map(() => '?').join(',')}))`);
    values.push(...forms);
  }
  if (!seed) return { candidates: [], total: 0, page: page(0) };
  const base = `WITH ids AS (${seed}) SELECT ids.id,ids.rank FROM ids WHERE
    (EXISTS (SELECT 1 FROM tfda_drugs WHERE id=ids.id) OR EXISTS (SELECT 1 FROM tfda_appearances WHERE id=ids.id))
    ${conditions.length ? ` AND ${conditions.join(' AND ')}` : ''}`;
  const total = (db.prepare(`SELECT COUNT(*) AS count FROM (${base})`).get(...values) as { count: number }).count;
  const rows = db.prepare(`SELECT ids.id FROM (${base}) ids
    LEFT JOIN tfda_drugs d ON d.id = ids.id LEFT JOIN tfda_appearances a ON a.id = ids.id
    ORDER BY ids.rank, COALESCE(d.active, 0) DESC, COALESCE(d.name, a.name), ids.id LIMIT ? OFFSET ?`).all(...values, limit, offset) as { id: string }[];
  return { candidates: rows.map(row => getTfda(db, row.id)!), total, page: page(total) };
}

export function getTfda(db: DrugDatabase, id: string): DrugCandidate | null {
  const row = db.prepare('SELECT payload FROM tfda_drugs WHERE id = ?').get(id) as { payload: string } | undefined;
  const visual = db.prepare('SELECT name, english_name, payload FROM tfda_appearances WHERE id = ?').get(id) as { name: string; english_name: string; payload: string } | undefined;
  const appearance: DrugAppearance | undefined = visual ? JSON.parse(visual.payload) : undefined;
  if (row) return { ...JSON.parse(row.payload), ...(appearance ? { appearance } : {}) };
  if (!visual) return null;
  return { source: 'tfda', id, name: visual.name, englishName: visual.english_name, ingredients: [], dosageForm: '',
    manufacturer: '', licenseStatus: '尚未核對許可證主檔', validUntil: '', indications: '', dosageText: '',
    sourceUrl: APPEARANCE_URL, appearance, appearanceOnly: true };
}

export function findDdinter(db: DrugDatabase, name: string): string | undefined {
  const rows = db.prepare('SELECT id FROM ddinter_all_drugs WHERE normalized_name = ?').all(normalizeName(name)) as { id: string }[];
  return rows.length === 1 ? rows[0].id : undefined;
}

export function compareIngredients(db: DrugDatabase, meds: MedicationEvidence[]): InteractionEvidence[] {
  const readMechanism = createDdinterMechanismReader(db);
  const available = datasetStatus(db).find(s => s.source === 'ddinter')!.count > 0;
  const ingredients = meds.flatMap((med, medicationIndex) => med.ingredients.map(ingredient => ({ ingredient, medicationIndex, drug: med.drug.name })));
  const pairs: InteractionEvidence[] = [];
  for (let a = 0; a < ingredients.length; a++) {
    for (let b = a + 1; b < ingredients.length; b++) {
      const left = ingredients[a], right = ingredients[b];
      const x = left.ingredient, y = right.ingredient;
      const pair: InteractionEvidence = { drugA: left.drug, drugB: right.drug, ingredientA: x.original,
        ingredientB: y.original, scope: left.medicationIndex === right.medicationIndex ? 'within_product' : 'between_products',
        status: 'not_found', sourceUrl: DDINTER_URL };
      const duplicate = (x.rxCui && x.rxCui === y.rxCui) || (x.ddinterId && x.ddinterId === y.ddinterId) || normalizeName(x.name) === normalizeName(y.name);
      if (duplicate && left.medicationIndex === right.medicationIndex) continue;
      if (duplicate) { pair.status = 'duplicate'; pair.sourceUrl = meds[left.medicationIndex].drug.sourceUrl; }
      else if (!available) pair.status = 'not_imported';
      else if (!x.ddinterId || !y.ddinterId) pair.status = 'unmapped';
      else {
        const [idA, idB] = [x.ddinterId, y.ddinterId].sort();
        const row = db.prepare('SELECT level FROM ddinter_pairs WHERE drug_a = ? AND drug_b = ?').get(idA, idB) as { level: string } | undefined;
        if (row) { pair.status = 'found'; pair.level = row.level; }
        else {
          const snapshot = db.prepare(`SELECT p.level, s.source_url, s.data_url, s.retrieved_at FROM ddinter_web_pairs p
            JOIN ddinter_web_snapshots s ON s.id=p.root_id WHERE p.drug_a=? AND p.drug_b=? ORDER BY s.retrieved_at DESC,s.id LIMIT 1`)
            .get(idA, idB) as { level: string; source_url: string; data_url: string; retrieved_at: string } | undefined;
          if (snapshot) {
            pair.status = 'found'; pair.level = snapshot.level; pair.sourceUrl = snapshot.source_url;
            pair.websiteSnapshot = { retrievedAt: snapshot.retrieved_at, dataUrl: snapshot.data_url };
          }
        }
        if (pair.status === 'found' && pair.level) {
          pair.detail = readDdinterDetail(db, idA, idB, pair.level);
          const mechanism = readMechanism(idA, idB, pair.level);
          if (mechanism) pair.mechanism = mechanism;
        }
      }
      pairs.push(pair);
    }
  }
  return pairs;
}
