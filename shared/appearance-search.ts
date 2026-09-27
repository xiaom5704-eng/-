export interface AppearanceOptions { shapes: string[]; colors: string[] }

// Use the same literal terms in the query fields and the local appearance index.
// Color suffixes and whitespace are presentation differences; imprints retain
// punctuation and full faces, and no synonym or color similarity is inferred.
export const appearanceTerms = (value: string, kind: 'shape' | 'color' | 'imprint') => [...new Set(value.split(kind === 'imprint' ? /;;;|；；；/ : /;;;|；；；|、|,|，|\//).map(part => {
  const normalized = part.normalize('NFKC').toLowerCase().trim().replace(/\s/g, '');
  return kind === 'color' ? normalized.replace(/色$/, '') : normalized;
}).filter(Boolean))];
