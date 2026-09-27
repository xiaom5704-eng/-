import type { DrugSelection } from '../../shared/medication';
import { safetySources } from '../../shared/medication-safety';
import { matchingDocumentSource } from './source-documents';

const coldExtraLicense = '衛署藥輸字第023784號';
const coldExtraLabel = {
  title: 'TFDA 公開仿單（2016 版，請核對最新版本）',
  sourceUrl: 'https://www.fda.gov.tw/tc/includes/GetFile.ashx?id=f636700104403134386&type=1',
};

// Reviewed 2026-09-27 against both names' exact RxNorm lookups and active IN
// properties (version 08-Sep-2026). Match the complete annotation, never remove
// arbitrary parentheses: niacin and niacinamide are different IN concepts.
// Evidence and scope: docs/本機成分對照.md, "已核對的完整別名寫法".
const reviewedSynonyms = new Map([
  ['NIACINAMIDE (NICOTINAMIDE)', { name: 'nicotinamide', sourceUrl: 'https://rxnav.nlm.nih.gov/REST/rxcui.json?name=nicotinamide&search=0' }],
  ['CYANOCOBALAMIN (VIT B12)', { name: 'cyanocobalamin', sourceUrl: 'https://rxnav.nlm.nih.gov/REST/rxcui.json?name=cyanocobalamin&search=0' }],
  ['NIACIN (NICOTINIC ACID)', { name: 'niacin', sourceUrl: 'https://rxnav.nlm.nih.gov/REST/rxcui.json?name=nicotinic%20acid&search=0' }],
]);

// Reviewed 2026-09-17. These aliases identify ingredients only, never strength,
// formulation or clinical equivalence. Product-label evidence stays license-scoped.
export function verifiedIngredientName(original: string, drug?: DrugSelection) {
  const name = original.normalize('NFKC').trim().replace(/\s+/g, ' ').toUpperCase();
  const synonym = reviewedSynonyms.get(name);
  if (synonym) return { ...synonym };
  if (name === 'CAFFEINE ANHYDROUS') return {
    name: 'caffeine',
    sourceUrl: 'https://precision.fda.gov/ginas/app/ui/substances/3G6A5W338E',
  };
  // K.B.T. label, 2023-02-24, section 1.1; reviewed 2026-09-20.
  // Keep these names scoped to the reviewed license, not arbitrary parentheses.
  if (drug?.source === 'tfda' && drug.id === '內衛藥製字第007592號') {
    if (name === 'KAOLIN (WHITE)(BOLUS ALBA)') return { name: 'kaolin', sourceUrl: safetySources.kbt.url };
    if (name === 'ALBUMIN TANNATE (TANNALBIN)') return { name: 'albumin tannate', sourceUrl: safetySources.kbt.url };
  }
  if (drug?.source !== 'tfda' || drug.id !== coldExtraLicense) return undefined;
  if (name === 'ACETAMINOPHEN FINE') return { name: 'acetaminophen', sourceUrl: coldExtraLabel.sourceUrl };
  if (name === 'ASCORBIC ACID (COATED)') return { name: 'ascorbic acid', sourceUrl: coldExtraLabel.sourceUrl };
  return undefined;
}

export function verifiedProductLabel(drug: DrugSelection & { ingredients?: string[] }) {
  const source = matchingDocumentSource(drug);
  return source ? { title: `${source.title}（${source.version}）`, sourceUrl: source.url } : undefined;
}
