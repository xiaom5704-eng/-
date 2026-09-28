import type { DrugAppearance, MedicationObservation } from '../../shared/medication';
import { normalizeImprint } from '../../shared/appearance-search';
import { applyImprintSuggestion, imprintDifference, imprintSuggestionInputs, type ImprintSuggestion, type ImprintSuggestions } from '../../shared/imprint-suggestions';
import { matchObservation } from './appearance';
import type { DrugDatabase } from './store';

export function suggestLocalImprints(db: DrugDatabase, observation: MedicationObservation): ImprintSuggestions {
  const inputs = imprintSuggestionInputs(observation);
  if (!inputs.length || matchObservation(db, observation).total) return { suggestions: [], hasMore: false };
  const possible = new Map<string, Pick<ImprintSuggestion, 'index' | 'text'>>();
  const add = (text: string) => {
    for (const input of inputs) if (imprintDifference(input.text, text)) {
      const key = `${input.index}:${normalizeImprint(text)}`;
      if (!possible.has(key)) possible.set(key, { index: input.index, text });
    }
  };
  // Read current source columns on each explicit request, including the same
  // cross-column combinations accepted by exact search. Never join alternatives
  // within one field, or build suggestions from product names or manufacturers.
  for (const row of db.prepare('SELECT payload FROM tfda_appearances ORDER BY id').iterate() as Iterable<{ payload: string }>) {
    const appearance: DrugAppearance = JSON.parse(row.payload);
    const fields = [appearance.imprint1, appearance.imprint2].map(value => [...new Set((value || '').split(/;;;|；；；/).map(text => text.trim()).filter(Boolean))]);
    for (const text of fields.flat()) add(text);
    for (const first of fields[0]) for (const second of fields[1]) {
      if (!inputs.some(input => normalizeImprint(input.text).length === normalizeImprint(first + second).length)) continue;
      add(`${first} ${second}`); add(`${second} ${first}`);
    }
  }
  const suggestions: ImprintSuggestion[] = [];
  for (const [, suggestion] of [...possible].sort(([a], [b]) => a.localeCompare(b))) {
    // Preserve name, strength, dosage form, colors, shape and the other imprint.
    const count = matchObservation(db, applyImprintSuggestion(observation, suggestion)).total;
    if (count) suggestions.push({ ...suggestion, count });
    if (suggestions.length === 9) break;
  }
  return { suggestions: suggestions.slice(0, 8), hasMore: suggestions.length > 8 };
}
