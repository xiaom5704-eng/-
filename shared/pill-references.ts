import type { DrugCandidate } from './medication';

// Compare the identity the user actually reviewed with the current master data.
// Appearance URLs and label download availability are not product identity.
export function pillReferenceIdentity(drug: DrugCandidate): string {
  return JSON.stringify([drug.source, drug.id, drug.name, drug.englishName || '',
    drug.ingredients, drug.dosageForm, drug.manufacturer || '']);
}

export function canCollectPillReference(drug: DrugCandidate): boolean {
  return drug.source === 'tfda' && !drug.appearanceOnly && drug.ingredients.length > 0 && /錠|膠囊|丸劑/.test(drug.dosageForm);
}

export interface PersonalPillPhoto {
  key: string; drugId: string; name: string; sourceNote: string; createdAt: string;
  usable: boolean; disabled: boolean; reason?: string; imageUrl?: string;
}
export interface PersonalPillLibrary { photos: PersonalPillPhoto[]; warning?: string }
