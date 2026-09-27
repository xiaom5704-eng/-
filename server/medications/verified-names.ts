import type { DrugSelection } from '../../shared/medication';
import { safetySources } from '../../shared/medication-safety';
import { matchingDocumentProduct } from './source-documents';

const coldExtraLicense = '衛署藥輸字第023784號';
const coldExtraLabel = {
  title: 'TFDA 公開仿單（2016 版，請核對最新版本）',
  sourceUrl: 'https://www.fda.gov.tw/tc/includes/GetFile.ashx?id=f636700104403134386&type=1',
};

// Reviewed 2026-09-17. These aliases identify ingredients only, never strength,
// formulation or clinical equivalence. Product-label evidence stays license-scoped.
export function verifiedIngredientName(original: string, drug?: DrugSelection) {
  const name = original.normalize('NFKC').trim().replace(/\s+/g, ' ').toUpperCase();
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
  if (drug.source !== 'tfda') return undefined;
  if (drug.id === coldExtraLicense) {
    const expected = ['ACETAMINOPHEN FINE', 'ASCORBIC ACID (COATED)', 'CAFFEINE ANHYDROUS'];
    const actual = drug.ingredients?.map(name => name.normalize('NFKC').trim().toUpperCase()).sort();
    return actual?.length === expected.length && actual.every((name, i) => name === expected[i]) ? coldExtraLabel : undefined;
  }
  if (!matchingDocumentProduct(drug)) return undefined;
  const source = ({ '衛署藥製字第038983號': safetySources.noscapine, '衛署藥製字第043588號': safetySources.cypromin,
    '衛署藥製字第027569號': safetySources.sominLabel, '衛署藥製字第031990號': safetySources.fencaineLabel,
    '內衛藥製字第007592號': safetySources.kbt } as Record<string, typeof safetySources.noscapine>)[drug.id];
  return source ? { title: `${source.title}（${source.version}）`, sourceUrl: source.url } : undefined;
}
