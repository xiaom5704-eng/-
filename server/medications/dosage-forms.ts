import type { DrugDatabase } from './store';
import { searchRevision } from './search-index';
import { dosageFormKey } from '../../shared/dosage-form';

const cache = new WeakMap<DrugDatabase, { revision: string; forms: string[] }>();
export function localDosageForms(db: DrugDatabase): string[] {
  const revision = searchRevision(db), existing = cache.get(db);
  if (existing?.revision === revision) return existing.forms;
  const rows = db.prepare("SELECT json_extract(payload,'$.dosageForm') AS dosage_form, COUNT(*) AS total FROM tfda_drugs GROUP BY dosage_form ORDER BY total DESC, dosage_form").all() as { dosage_form: string | null }[];
  const forms = rows.map(row => row.dosage_form).filter((value): value is string => typeof value === 'string' && !!value.trim());
  cache.set(db, { revision, forms });
  return forms;
}

export function resolveDosageForm(db: DrugDatabase, input: string) {
  const key = dosageFormKey(input);
  return key ? localDosageForms(db).filter(form => dosageFormKey(form) === key) : [];
}

export function dosageFormSearchNotice(db: DrugDatabase, input: string): string[] {
  if (!input.trim()) return [];
  const forms = resolveDosageForm(db, input);
  return [forms.length ? `劑型依來源欄位篩選：${forms.join('、')}。不同細分類不自動合併；這不是給藥途徑或用藥適用性的判定。`
    : `劑型「${input.trim()}」尚無本機欄位對照，未列出候選。請校正或清空劑型後重新查詢。`];
}
