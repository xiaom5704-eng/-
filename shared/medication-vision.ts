import type { DrugCandidate } from './medication';
import { isUnitVisionVector } from './vision-vector.mjs';

export interface VisionStatus {
  ready: boolean; reason?: string; imageCount: number; drugCount: number;
  indexedAt?: string; sourceVersion?: string; model: string;
  kind?: 'pill' | 'package'; productCount?: number;
  personalImageCount?: number; personalWarning?: string;
  officialPackageImageCount?: number; referenceWarning?: string;
}
export interface VisionCandidate {
  drug: DrugCandidate; similarity: number | null;
  matchedBy: 'image' | 'imprint' | 'image_and_imprint';
  imprint: 'match' | 'different' | 'missing' | 'not_given';
  images: { url: string; sourceUrl: string; sourceNote?: string; provenance?: 'personal' }[];
}
export interface VisionResult {
  status: VisionStatus; candidates: VisionCandidate[];
  outcome: 'review' | 'low_similarity'; warnings: string[];
  imprintSearch?: { input: string; total: number; shown: number };
}

export interface VisualReference { key: string; drugId: string; vector: Float32Array }

// A retrieval scope, not a route-of-administration or safety determination.
// Keep tablet/capsule forms (including non-oral tablets), and unknown forms.
// Clearly incompatible vials, liquids and topical containers stay searchable by
// name and retain their reference images outside the pill-only CV results.
export function eligibleForPillSearch(drug: Pick<DrugCandidate, 'dosageForm'>): boolean {
  const form = drug.dosageForm || '';
  if (/錠|膠囊|丸劑/.test(form)) return true;
  return !/注射|輸液|液|乳膏|軟膏|凝膠|貼|氣體|粉劑|散劑|顆粒|浣腸|口內膏|牙膏|棒劑|植入|栓劑|噴|口溶膜/.test(form);
}

// A retrieval threshold, not a calibrated probability of drug identity.
export const MIN_VISUAL_SIMILARITY = 0.60;
export function rankVisualReferences(queries: Float32Array[], references: VisualReference[], limit = 8, minimumSimilarity = MIN_VISUAL_SIMILARITY) {
  if (!queries.length || queries.length > 2) throw new Error('請提供同一種藥品的 1–2 張照片。');
  const dimensions = queries[0].length;
  if (queries.some(query => !isUnitVisionVector(query, dimensions))) throw new Error('影像特徵格式無效。');
  const matches = new Map<string, { drugId: string; views: { key: string; similarity: number }[] }>();
  for (const reference of references) {
    if (!isUnitVisionVector(reference.vector, dimensions)) continue;
    let drug = matches.get(reference.drugId);
    if (!drug) { drug = { drugId: reference.drugId, views: queries.map(() => ({ key: '', similarity: -Infinity })) }; matches.set(reference.drugId, drug); }
    queries.forEach((query, i) => {
      let similarity = 0;
      for (let j = 0; j < dimensions; j++) similarity += query[j] * reference.vector[j];
      similarity = Math.max(-1, Math.min(1, similarity));
      if (similarity > drug!.views[i].similarity) drug!.views[i] = { key: reference.key, similarity };
    });
  }
  return [...matches.values()].map(drug => ({ ...drug, similarity: drug.views.reduce((n, view) => n + view.similarity, 0) / queries.length }))
    .filter(drug => drug.views.every(view => view.similarity >= minimumSimilarity))
    .sort((a, b) => b.similarity - a.similarity || a.drugId.localeCompare(b.drugId)).slice(0, limit);
}

export function compareImprint(input: string, appearance?: DrugCandidate['appearance']): VisionCandidate['imprint'] {
  const normalize = (text: string) => text.normalize('NFKC').toUpperCase().replace(/\s/g, '');
  if (!input.trim()) return 'not_given';
  const marks = [appearance?.imprint1 || '', appearance?.imprint2 || ''].flatMap(mark => mark.split(/;;;|；；；/)).map(normalize).filter(Boolean);
  if (!marks.length) return 'missing';
  return marks.includes(normalize(input)) ? 'match' : 'different';
}
