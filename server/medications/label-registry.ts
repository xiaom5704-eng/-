import type { LabelEvidence, LabelLookup, ResolvedIngredient } from '../../shared/medication';
import { normalizeName, type DrugDatabase } from './store';

export const LABELS_URL = 'https://api.fda.gov/drug/label.json';
export const LABEL_PAGE_SIZE = 100;
export const LABEL_MAX_PAGES = 5;
export const LABEL_REMINDER_MS = 7 * 24 * 60 * 60 * 1000;
export interface LabelSnapshot {
  schema: 1;
  textVersion?: 2;
  tableVersion?: 1;
  rawLabels?: unknown[];
  retrievedAt: string;
  sourceUrl: string;
  sourceUpdatedAt?: string;
  scanned: number;
  total: number | null;
  complete: boolean;
  labels: LabelEvidence[];
}

export function labelContext(ingredients: ResolvedIngredient[]) {
  if (!ingredients.length || ingredients.some(item => !item.rxCui || !/^\d+$/.test(item.rxCui) || !item.name.trim())) return undefined;
  const identities = [...new Set(ingredients.map(item => JSON.stringify([normalizeName(item.name), item.rxCui])))].sort();
  const names = [...new Set(ingredients.map(item => normalizeName(item.name)))].sort();
  const aliases = new Map<string, Set<string>>();
  for (const item of ingredients) {
    const group = aliases.get(item.rxCui!) || new Set<string>();
    group.add(normalizeName(item.name));
    // This name was already proven to relate to this IN by the exact RxNorm pipeline.
    // Never strip salt words or introduce unverified variants from the label response.
    if (item.normalization) group.add(normalizeName(item.normalization.matchedName));
    aliases.set(item.rxCui!, group);
  }
  const groups = [...aliases.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, values]) => [...values].sort());
  const url = new URL(LABELS_URL);
  const term = (name: string) => `openfda.substance_name:"${name.replace(/["\\]/g, ' ')}"`;
  url.searchParams.set('search', groups.map(group => group.length === 1 ? term(group[0]) : `(${group.map(term).join(' OR ')})`).join(' AND '));
  url.searchParams.set('limit', String(LABEL_PAGE_SIZE)); url.searchParams.set('sort', 'effective_time:desc');
  const hasAliases = groups.some(group => group.length > 1);
  return { key: JSON.stringify(hasAliases ? [1, identities, groups] : [1, identities]), names, groups, url: url.toString() };
}

const stringList = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string');
const sameIngredients = (values: string[], groups: string[][]) => {
  const actual = [...new Set(values.map(normalizeName))];
  if (actual.length !== groups.length) return false;
  const matches = actual.map(name => groups.flatMap((group, index) => group.includes(name) ? [index] : []));
  return matches.every(match => match.length === 1) && new Set(matches.map(match => match[0])).size === groups.length;
};
const sections = [
  ['boxed_warning', '加框警語'], ['indications_and_usage', '適應症'], ['drug_interactions', '交互作用'],
  ['pediatric_use', '兒童使用資訊'], ['geriatric_use', '高齡者使用資訊'], ['use_in_specific_populations', '特定族群使用資訊'],
  ['dosage_and_administration', '用法用量'], ['contraindications', '禁忌'], ['warnings_and_cautions', '警語與注意事項'], ['warnings', '警語'],
  ['precautions', '注意事項'], ['general_precautions', '一般注意事項'],
  ['do_not_use', '不宜使用情況'], ['ask_doctor', '使用前詢問醫師'], ['ask_doctor_or_pharmacist', '使用前詢問醫師或藥師'],
  ['when_using', '使用期間注意事項'], ['stop_use', '停用與就醫資訊'], ['other_safety_information', '其他安全資訊'],
  ['keep_out_of_reach_of_children', '兒童誤用防範'], ['information_for_patients', '給使用者的資訊'],
  ['patient_medication_information', '病人用藥資訊'], ['instructions_for_use', '使用說明'],
  ['spl_medguide', '用藥指南'], ['spl_patient_package_insert', '病人用仿單'],
  ['pregnancy', '懷孕資訊'], ['nursing_mothers', '哺乳資訊'], ['pregnancy_or_breast_feeding', '懷孕或哺乳資訊'],
  ['labor_and_delivery', '分娩資訊'], ['teratogenic_effects', '致畸胎相關資訊'], ['nonteratogenic_effects', '非致畸胎相關資訊'],
  ['adverse_reactions', '不良反應'], ['overdosage', '過量資訊'],
  ['drug_and_or_laboratory_test_interactions', '藥品與檢驗的交互影響'], ['laboratory_tests', '檢驗資訊'],
  ['drug_abuse_and_dependence', '濫用與依賴'], ['abuse', '濫用資訊'], ['dependence', '依賴資訊'], ['controlled_substance', '管制藥品資訊'],
  ['dosage_forms_and_strengths', '劑型與含量'], ['active_ingredient', '有效成分'], ['inactive_ingredient', '非有效成分'],
  ['purpose', '用途類別'], ['description', '藥品描述'], ['clinical_pharmacology', '臨床藥理'],
  ['mechanism_of_action', '作用機轉'], ['pharmacodynamics', '藥效學'], ['pharmacokinetics', '藥物動力學'], ['pharmacogenomics', '藥物基因體資訊'],
  ['microbiology', '微生物學資訊'], ['nonclinical_toxicology', '非臨床毒理資訊'],
  ['carcinogenesis_and_mutagenesis_and_impairment_of_fertility', '致癌性、致突變性與生育力資訊'], ['clinical_studies', '臨床研究'],
  ['how_supplied', '包裝供應'], ['storage_and_handling', '保存與處理'], ['recent_major_changes', '近期重大變更'],
  ['health_care_provider_letter', '給醫療人員的通知'], ['questions', '產品諮詢資訊'], ['references', '參考文獻'],
  ['package_label_principal_display_panel', '包裝標示'], ['spl_unclassified_section', '其他原文段落'],
];

export function parseLabelPage(data: any, groups: string[][], includeTables = true) {
  if (!Array.isArray(data?.results) || data.results.length > LABEL_PAGE_SIZE) throw new Error('仿單回應格式異常');
  const matches: LabelEvidence[] = [];
  for (const r of data.results) {
    if (!r || typeof r !== 'object' || Array.isArray(r)) throw new Error('仿單紀錄格式異常');
    const substances = r.openfda?.substance_name;
    if (substances === undefined) continue; // FDA harmonization is not available on every record.
    if (!stringList(substances)) throw new Error('仿單成分格式異常');
    if (!sameIngredients(substances, groups)) continue;
    if (typeof r.id !== 'string' || !/^[a-z0-9_-]{1,128}$/i.test(r.id)) throw new Error('仿單缺少有效來源識別碼');
    for (const key of ['brand_name', 'generic_name', 'route']) {
      if (r.openfda[key] !== undefined && !stringList(r.openfda[key])) throw new Error('仿單欄位格式異常');
    }
    for (const key of ['set_id', 'version', 'effective_time']) {
      if (r[key] !== undefined && typeof r[key] !== 'string') throw new Error('仿單版本格式異常');
    }
    for (const [key] of sections) if (r[key] !== undefined && !stringList(r[key])) throw new Error('仿單段落格式異常');
    const tableFields = Object.keys(r).filter(key => key.endsWith('_table'));
    if (includeTables && tableFields.some(key => !stringList(r[key]))) throw new Error('仿單表格格式異常');
    const sectionList = includeTables ? [...sections, ...tableFields.filter(key => !sections.some(([field]) => `${field}_table` === key))
      .map(key => [key.slice(0, -6), `其他來源表格：${key.slice(0, -6)}`])] : sections;
    matches.push({ id: r.id, setId: r.set_id, version: r.version,
      brandNames: r.openfda.brand_name || [], genericNames: r.openfda.generic_name || [],
      ingredients: substances, routes: r.openfda.route || [], effectiveTime: r.effective_time || '未提供',
      sourceUrl: `${LABELS_URL}?search=${encodeURIComponent(`id:"${r.id}"`)}`,
      hasTables: Object.keys(r).some(key => key.endsWith('_table') && Array.isArray(r[key]) && r[key].length > 0),
      sections: sectionList.filter(([key]) => r[key]?.length || (includeTables && r[`${key}_table`]?.length)).map(([key, title]) => ({
        title, text: stringList(r[key]) ? r[key].join('\n\n') : '',
        ...(includeTables && r[`${key}_table`]?.length ? { tables: r[`${key}_table`] as string[] } : {}),
      })),
    });
  }
  return matches;
}

export function readLabelSnapshot(db: DrugDatabase, context: NonNullable<ReturnType<typeof labelContext>>): LabelSnapshot | undefined {
  const row = db.prepare('SELECT payload FROM label_registry WHERE key=?').get(context.key) as { payload: string } | undefined;
  if (!row) return undefined;
  try {
    const s = JSON.parse(row.payload) as LabelSnapshot;
    if (s.schema !== 1 || s.sourceUrl !== context.url || !Number.isFinite(Date.parse(s.retrievedAt)) ||
        !Number.isSafeInteger(s.scanned) || s.scanned < 0 || s.scanned > LABEL_PAGE_SIZE * LABEL_MAX_PAGES ||
        (s.total !== null && (!Number.isSafeInteger(s.total) || s.total < s.scanned)) || typeof s.complete !== 'boolean' ||
        (s.sourceUpdatedAt !== undefined && typeof s.sourceUpdatedAt !== 'string') ||
        !Array.isArray(s.labels) || s.labels.length > 2) return undefined;
    if (!s.labels.every(label => typeof label.id === 'string' && /^[a-z0-9_-]{1,128}$/i.test(label.id) &&
        stringList(label.ingredients) && sameIngredients(label.ingredients, context.groups) &&
        label.sourceUrl === `${LABELS_URL}?search=${encodeURIComponent(`id:"${label.id}"`)}` &&
        stringList(label.brandNames) && stringList(label.genericNames) && stringList(label.routes) &&
        typeof label.effectiveTime === 'string' &&
        (label.hasTables === undefined || typeof label.hasTables === 'boolean') &&
        (label.version === undefined || typeof label.version === 'string') && (label.setId === undefined || typeof label.setId === 'string') &&
        Array.isArray(label.sections) && label.sections.every(section => typeof section.title === 'string' && typeof section.text === 'string' &&
          (section.tables === undefined || stringList(section.tables))))) return undefined;
    if (s.textVersion === 2) {
      if (!Array.isArray(s.rawLabels) || JSON.stringify(parseLabelPage({ results: s.rawLabels }, context.groups, s.tableVersion === 1)) !== JSON.stringify(s.labels)) return undefined;
      if (s.tableVersion === 1) return s;
      // Version 2 retained source HTML, so tables can be recovered even after
      // the temporary API cache expired. Keep acquisition time and text intact.
      try {
        const upgraded: LabelSnapshot = { ...s, tableVersion: 1, labels: parseLabelPage({ results: s.rawLabels }, context.groups) };
        writeLabelSnapshot(db, context.key, upgraded); return upgraded;
      } catch { return s; }
    }
    // Older snapshots omitted safety sections. Recover only the identical source
    // records from this query's cached pages; an offline read never fetches anew.
    const raw = new Map<string, any>();
    for (let skip = 0; skip < s.scanned; skip += LABEL_PAGE_SIZE) {
      const url = new URL(context.url); if (skip) url.searchParams.set('skip', String(skip));
      const cached = db.prepare('SELECT value,retrieved_at FROM drug_api_cache WHERE key=?').get(url.toString()) as { value: string; retrieved_at: number | null } | undefined;
      if (!cached?.retrieved_at || !Number.isFinite(cached.retrieved_at)) continue;
      try {
        const data = JSON.parse(cached.value);
        if (!Array.isArray(data.results) || data.results.length > LABEL_PAGE_SIZE) continue;
        for (const record of data.results) if (record && typeof record.id === 'string') raw.set(record.id, record);
      } catch { /* Preserve the original snapshot when a cache page is corrupt. */ }
    }
    const rawLabels = s.labels.map(label => raw.get(label.id));
    if (rawLabels.some(record => !record)) return s;
    try {
      const expanded = parseLabelPage({ results: rawLabels }, context.groups);
      if (expanded.length !== s.labels.length || expanded.some((label, i) => {
        const old = s.labels[i];
        return ['id', 'setId', 'version', 'brandNames', 'genericNames', 'ingredients', 'routes', 'effectiveTime', 'sourceUrl']
          .some(key => JSON.stringify(label[key]) !== JSON.stringify(old[key])) ||
          old.sections.some(section => !label.sections.some(next => next.title === section.title && next.text === section.text));
      })) return s;
      const upgraded: LabelSnapshot = { ...s, textVersion: 2, tableVersion: 1, rawLabels, labels: expanded };
      writeLabelSnapshot(db, context.key, upgraded);
      return upgraded;
    } catch { return s; }
  } catch { return undefined; }
}

export function writeLabelSnapshot(db: DrugDatabase, key: string, snapshot: LabelSnapshot) {
  db.prepare('INSERT OR REPLACE INTO label_registry(key,payload) VALUES(?,?)').run(key, JSON.stringify(snapshot));
}

export function labelResult(snapshot: LabelSnapshot, reused: boolean, refresh: LabelLookup['refresh']) {
  const { labels, schema: _schema, textVersion, tableVersion: _tableVersion, rawLabels: _rawLabels, ...source } = snapshot;
  const lookup: LabelLookup = { ...source, textSectionsExpanded: textVersion === 2, reused, refresh, stale: Date.now() - Date.parse(snapshot.retrievedAt) > LABEL_REMINDER_MS };
  return { labels, status: labels.length ? 'found' as const : snapshot.complete ? 'not_found' as const : 'incomplete' as const, lookup };
}
