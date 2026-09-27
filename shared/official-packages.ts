import type { DrugCandidate } from './medication';

export interface OfficialPackagePhoto {
  key: string; drugId: string; sourceUrl: string; retrievedAt: string;
  indexRetrievedAt: string; sourceSha256: string; usable: boolean;
  page: number; pageCount: number;
  disabled: boolean; pending: boolean; imageUrl?: string; reason?: string;
}
export interface OfficialPackageLibrary { photos: OfficialPackagePhoto[]; warning?: string }
export const officialPackageIdentity = (drug: DrugCandidate) => JSON.stringify([
  drug.source, drug.id, drug.name, drug.englishName, drug.ingredients, drug.dosageForm, drug.manufacturer,
]);
