import { canSuggestName, oneNameEdit, type NameSuggestions } from '../../shared/name-suggestions';
import { searchKey, searchRevision } from './search-index';
import { searchLocalCandidates, type DrugDatabase } from './store';

const dictionaries = new WeakMap<DrugDatabase, { revision: string; words: { text: string; key: string; chinese: boolean }[] }>();

export function suggestLocalNames(db: DrugDatabase, input: string, dosageForm = ''): NameSuggestions {
  if (!canSuggestName(input) || searchLocalCandidates(db, input, undefined, { dosageForm }).total) return { suggestions: [] };
  const revision = searchRevision(db);
  let dictionary = dictionaries.get(db);
  if (!dictionary || dictionary.revision !== revision) {
    // Only source product names: not manufacturers, ingredients, licenses or imprints.
    const rows = db.prepare(`SELECT name, english_name FROM tfda_drugs
      UNION SELECT name, english_name FROM tfda_appearances`).all() as { name: string; english_name: string }[];
    const words = new Set<string>();
    for (const row of rows) for (const name of [row.name, row.english_name]) {
      for (const word of name.normalize('NFKC').match(/[a-zA-Z]+|[\u3400-\u9fff]+/g) || []) {
        if (word.length >= 3) words.add(word);
      }
    }
    dictionary = { revision, words: [...words].sort().map(text => ({ text, key: searchKey(text), chinese: /^[\u3400-\u9fff]+$/.test(text) })) };
    dictionaries.set(db, dictionary);
  }
  const key = searchKey(input), chinese = /^[\u3400-\u9fff]+$/.test(key);
  const possible = new Map<string, string>();
  const add = (text: string, normalized: string) => {
    if (canSuggestName(text) && oneNameEdit(key, normalized) && !possible.has(normalized)) possible.set(normalized, text);
  };
  for (const word of dictionary.words) {
    if (word.chinese !== chinese) continue;
    if (!chinese) add(word.text, word.key);
    else if (word.key.length === word.text.length) {
      // Chinese names often have no spaces; preserve the actual source characters.
      for (const length of [key.length, key.length - 1, key.length + 1]) {
        if (length < 3 || length > 16) continue;
        for (let start = 0; start + length <= word.key.length; start++) add(word.text.slice(start, start + length), word.key.slice(start, start + length));
      }
    }
  }
  const suggestions: string[] = [];
  const prefix = (word: string) => { let count = 0; while (count < key.length && key[count] === word[count]) count++; return count; };
  // This is a short spelling aid, not a confidence ranking or complete candidate list.
  for (const [normalized, text] of [...possible].sort(([a], [b]) => prefix(b) - prefix(a) || Math.abs(a.length - key.length) - Math.abs(b.length - key.length) || a.localeCompare(b)).slice(0, 40)) {
    if (normalized !== key && searchLocalCandidates(db, text, undefined, { dosageForm }).total) suggestions.push(text);
    if (suggestions.length === 8) break;
  }
  return { suggestions };
}
