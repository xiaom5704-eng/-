import type { DrugSelection, InteractionEvidence, MedicationReport, ResolvedIngredient } from './medication';
import type { MedicationPatient } from './medication-safety';

// An old result may remain visible during a refresh only for the exact same
// selections and patient context. Age units must never be rounded or converted.
export function reportMatchesSelection(report: MedicationReport | null, drugs: DrugSelection[], patient: MedicationPatient, demoId?: string): boolean {
  const previous = report?.safety?.patient;
  return !!report && !!previous && report.demo?.id === demoId &&
    report.medications.length === drugs.length && report.medications.every(({ drug }, i) => drug.source === drugs[i].source && drug.id === drugs[i].id) &&
    previous.age.value === patient.age.value && previous.age.unit === patient.age.unit && previous.premature === patient.premature;
}

// Display only, never used for ingredient matching or risk assessment.
// https://www.fda.gov.tw/TC/PublishOtherEpaperContent.aspx?id=1538&r=251002883&tid=4980
const familiarNames: Record<string, string> = { acetaminophen: '乙醯胺酚', caffeine: '咖啡因' };
export function ingredientName(ingredient: Pick<ResolvedIngredient, 'name'>): string {
  return familiarNames[ingredient.name.toLowerCase()] || ingredient.name;
}

export interface InteractionGroup {
  key: string;
  names: string[];
  drugs: string[];
  status: InteractionEvidence['status'];
  level?: string;
  internal: boolean;
  pairs: InteractionEvidence[];
}

// Collapse repeated displays while retaining every original pair. Conflicting
// identities, statuses, levels and internal/cross-product pairs stay separate.
export function interactionGroups(report: MedicationReport): InteractionGroup[] {
  const groups = new Map<string, InteractionGroup>();
  function describe(drug: string, original: string) {
    const matches = report.medications.filter(m => m.drug.name === drug).flatMap(m => m.ingredients.filter(i => i.original === original));
    const identities = new Set(matches.map(i => i.rxCui ? `rx:${i.rxCui}` : i.ddinterId ? `dd:${i.ddinterId}` : `name:${i.name}`));
    return matches.length && identities.size === 1
      ? { key: [...identities][0], name: ingredientName(matches[0]) }
      : { key: `raw:${drug}:${original}`, name: original };
  }
  for (const pair of report.interactions) {
    const ingredients = [describe(pair.drugA, pair.ingredientA), describe(pair.drugB, pair.ingredientB)].sort((a, b) => a.key.localeCompare(b.key));
    const internal = pair.scope === 'within_product';
    const key = JSON.stringify([pair.status, pair.level || '', internal, ingredients.map(i => i.key)]);
    let group = groups.get(key);
    if (!group) {
      group = { key, names: [...new Set(ingredients.map(i => i.name))], drugs: [], status: pair.status, level: pair.level, internal, pairs: [] };
      groups.set(key, group);
    }
    group.pairs.push(pair);
    group.drugs = [...new Set([...group.drugs, pair.drugA, pair.drugB])];
  }
  return [...groups.values()];
}
