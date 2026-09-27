// Suggestions apply to a plain name only, never a strength, license or imprint.
export function canSuggestName(value: string) {
  const text = value.normalize('NFKC').trim();
  return /^[a-zA-Z]{4,32}$/.test(text) || /^[\u3400-\u9fff]{3,16}$/.test(text);
}

export interface NameSuggestions { suggestions: string[] }

// Exactly one insertion, deletion, substitution or adjacent transposition.
export function oneNameEdit(a: string, b: string) {
  if (a === b || Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  if (a.length < b.length) return a.slice(i) === b.slice(i + 1);
  if (a.length > b.length) return a.slice(i + 1) === b.slice(i);
  return a.slice(i + 1) === b.slice(i + 1) ||
    (a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2));
}
