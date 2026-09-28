import type { DrugAppearance } from './medication';

export interface AppearanceOptions { shapes: string[]; colors: string[] }
export type ImprintMatch = 'match' | 'combined_fields' | 'different' | 'missing' | 'not_given';
export const normalizeImprint = (value: string) => value.normalize('NFKC').toLowerCase().replace(/\s/g, '');
export const combinedImprintNotice = '刻字與來源兩欄合併相符；分欄不代表正反面，請對照原圖、實物與規格，尚未確認藥品。';

// Use the same literal terms in the query fields and the local appearance index.
// Color suffixes and whitespace are presentation differences; imprints retain
// punctuation and full faces, and no synonym or color similarity is inferred.
export const appearanceTerms = (value: string, kind: 'shape' | 'color' | 'imprint') => [...new Set(value.split(kind === 'imprint' ? /;;;|；；；/ : /;;;|；；；|、|,|，|\//).map(part => {
  const normalized = part.normalize('NFKC').toLowerCase().trim().replace(/\s/g, '');
  return kind === 'color' ? normalized.replace(/色$/, '') : normalized;
}).filter(Boolean))];

// TFDA's two annotation columns can describe one face or different faces.
// Retrieve complete field combinations, but never label them single-field matches.
export function compareStoredImprint(input: string, appearance?: Pick<DrugAppearance, 'imprint1' | 'imprint2'>): ImprintMatch {
  const query = normalizeImprint(input);
  if (!query) return 'not_given';
  const fields = [appearance?.imprint1 || '', appearance?.imprint2 || ''].map(value => appearanceTerms(value, 'imprint'));
  if (!fields.some(field => field.length)) return 'missing';
  if (fields.some(field => field.includes(query))) return 'match';
  if (fields[0].some(a => fields[1].some(b => query === a + b || query === b + a))) return 'combined_fields';
  return 'different';
}

export const hasImprintMatch = (result: ImprintMatch) => result === 'match' || result === 'combined_fields';
