import type { DrugDatabase } from './store';
import { compareStoredImprint, hasImprintMatch, normalizeImprint } from '../../shared/appearance-search';

export function findImprintMatches(db: DrugDatabase, input: string) {
  const query = normalizeImprint(input);
  if (!query || /;;;|；；；/.test(input)) return [];
  // A complete field must be the prefix of any two-field combination. The term
  // index only narrows candidates; canonical columns decide the actual match.
  const rows = db.prepare(`SELECT DISTINCT a.id,a.payload FROM tfda_appearance_terms t
    JOIN tfda_appearances a ON a.id=t.id
    WHERE t.kind='imprint' AND length(t.value)>0 AND substr(?,1,length(t.value))=t.value`).all(query) as { id: string; payload: string }[];
  return rows.flatMap(row => {
    const kind = compareStoredImprint(input, JSON.parse(row.payload));
    return hasImprintMatch(kind) ? [{ id: row.id, kind, rank: kind === 'match' ? 3 : 4 }] : [];
  }).sort((a, b) => a.rank - b.rank || a.id.localeCompare(b.id));
}
