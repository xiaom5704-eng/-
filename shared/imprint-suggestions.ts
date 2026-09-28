import type { MedicationObservation } from './medication';
import { normalizeImprint } from './appearance-search';

export interface ImprintSuggestion { index: number; text: string; count: number }
export interface ImprintSuggestions { suggestions: ImprintSuggestion[]; hasMore: boolean }
const eligible = (text: string) => text.length <= 120 && !/[\r\n]/.test(text) && /^[a-z0-9]{3,16}$/.test(normalizeImprint(text));

export function imprintSuggestionInputs(observation: MedicationObservation) {
  return (observation.appearance?.imprints || []).flatMap((text, index) => eligible(text) ? [{ text, index }] : []);
}

// A comparison aid only: no missing letters, punctuation removal, transposition,
// partial matching or automatic correction of a read imprint.
export function imprintDifference(input: string, source: string) {
  if (!eligible(input) || !eligible(source)) return null;
  const a = normalizeImprint(input), b = normalizeImprint(source);
  if (a.length !== b.length) return null;
  const changed = [...a].flatMap((char, index) => char !== b[index] ? [index] : []);
  return changed.length === 1 ? { position: changed[0] + 1, from: a[changed[0]].toUpperCase(), to: b[changed[0]].toUpperCase() } : null;
}

export function applyImprintSuggestion(observation: MedicationObservation, suggestion: Pick<ImprintSuggestion, 'index' | 'text'>): MedicationObservation {
  const appearance = observation.appearance;
  if (!appearance || !Number.isInteger(suggestion.index) || !imprintDifference(appearance.imprints[suggestion.index] || '', suggestion.text)) {
    throw new Error('刻字對照已失效，請重新查詢並核對照片。');
  }
  return { ...observation, appearance: { ...appearance,
    imprints: appearance.imprints.map((text, index) => index === suggestion.index ? suggestion.text : text) } };
}
