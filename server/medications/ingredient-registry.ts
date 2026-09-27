import { normalizeName, type DrugDatabase } from './store';
import type { ResolvedIngredient } from '../../shared/medication';

interface Concept { rxcui: string; name: string; tty: 'IN' | 'PIN'; suppress?: string }
export interface IngredientRecord {
  schema: 1;
  status: 'matched' | 'not_found' | 'needs_review';
  checkedAt: string;
  version: string;
  lookupUrl: string;
  reason?: string;
  matched?: Concept;
  ingredient?: Concept & { tty: 'IN' };
}

// Keep reviewed product aliases within the exact evidence context that authorized
// them. The same original ingredient in another product must not inherit a match.
export function ingredientRegistryKey(aliases: string[], aliasSourceUrl?: string) {
  return JSON.stringify([aliases.map(normalizeName), aliasSourceUrl || '']);
}

export function readIngredientRecord(db: DrugDatabase, key: string): IngredientRecord | undefined {
  const row = db.prepare('SELECT payload FROM ingredient_registry WHERE key = ?').get(key) as { payload: string } | undefined;
  if (!row) return undefined;
  try {
    const value = JSON.parse(row.payload) as IngredientRecord;
    if (value.schema !== 1 || !['matched', 'not_found', 'needs_review'].includes(value.status) ||
        !Number.isFinite(Date.parse(value.checkedAt)) || typeof value.version !== 'string' ||
        !value.lookupUrl?.startsWith('https://rxnav.nlm.nih.gov/REST/rxcui.json?')) return undefined;
    if (value.status === 'matched' && (!validConcept(value.matched) || !validConcept(value.ingredient) || value.ingredient.tty !== 'IN')) return undefined;
    return value;
  } catch { return undefined; }
}

export function exactLookupName(record: IngredientRecord): string | undefined {
  try {
    const url = new URL(record.lookupUrl);
    if (url.origin !== 'https://rxnav.nlm.nih.gov' || url.pathname !== '/REST/rxcui.json' ||
        url.searchParams.getAll('search').length !== 1 || url.searchParams.get('search') !== '0' ||
        url.searchParams.getAll('name').length !== 1) return undefined;
    return url.searchParams.get('name')?.trim() || undefined;
  } catch { return undefined; }
}

// Join two independently recorded exact lookups of the SAME active IN concept.
// DDInter-side PINs, products, qualified names and product-specific aliases must
// not be reduced to a base ingredient to manufacture an interaction match.
export function findDdinterByRxnorm(db: DrugDatabase, rxcui: string): ResolvedIngredient['ddinterNormalization'] | undefined {
  const rows = db.prepare("SELECT key FROM ingredient_registry WHERE json_valid(payload) AND json_extract(payload, '$.ingredient.rxcui') = ?").all(rxcui) as { key: string }[];
  const matches = new Map<string, NonNullable<ResolvedIngredient['ddinterNormalization']>>();
  for (const { key } of rows) {
    const record = readIngredientRecord(db, key);
    if (record?.status !== 'matched' || record.matched?.tty !== 'IN' || record.matched.suppress === 'Y' ||
        record.ingredient?.suppress === 'Y' || record.matched.rxcui !== rxcui || record.ingredient?.rxcui !== rxcui) continue;
    const name = exactLookupName(record);
    if (!name || key !== ingredientRegistryKey([name])) continue;
    const drugs = db.prepare('SELECT id,name FROM ddinter_all_drugs WHERE normalized_name = ?').all(normalizeName(name)) as { id: string; name: string }[];
    for (const drug of drugs) matches.set(drug.id, { ddinterId: drug.id, name: drug.name, rxCui: rxcui,
      checkedAt: record.checkedAt, version: record.version, lookupUrl: record.lookupUrl,
      sourceUrl: `https://rxnav.nlm.nih.gov/REST/rxcui/${rxcui}/properties.json` });
  }
  return matches.size === 1 ? [...matches.values()][0] : undefined;
}

export function validConcept(value: unknown): value is Concept {
  if (!value || typeof value !== 'object') return false;
  const item = value as Concept;
  return typeof item.rxcui === 'string' && /^\d+$/.test(item.rxcui) && typeof item.name === 'string' &&
    !!item.name.trim() && ['IN', 'PIN'].includes(item.tty);
}

export function writeIngredientRecord(db: DrugDatabase, key: string, value: IngredientRecord) {
  db.prepare('INSERT OR REPLACE INTO ingredient_registry(key,payload) VALUES(?,?)').run(key, JSON.stringify(value));
}
