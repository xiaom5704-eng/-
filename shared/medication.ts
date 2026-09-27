import { patientAgeText, safetyKindText, type MedicationDemo, type MedicationSafety } from './medication-safety';
import { sourceTableHtml, sourceTableUnavailable } from './label-tables';
import { interactionDetailScope, type InteractionDetail } from './interaction-detail';
import { validLocalDocument, type SavedSourceDocument } from './source-document';
import { mechanismDefinitions, mechanismDefinitionUrl, mechanismScope, type InteractionMechanism } from './interaction-mechanism';

export type DrugSource = 'tfda' | 'rxnorm';
export type ReportMode = 'local' | 'online';
export interface DrugAppearance {
  shape: string; color: string; score: string; size: string;
  imprint1: string; imprint2: string; imageUrls: string[]; sourceUrl: string;
  localImageUrls?: Record<string, string>;
  localDetailImages?: Record<string, { url: string; width: number; height: number; fetchedAt: string }>;
}
export interface MedicationObservation {
  name: string; strength: string; dosageForm: string;
  appearance?: { shape: string; color: string; imprints: string[] };
}
export interface MedicationMatch {
  observation: MedicationObservation; candidates: DrugCandidate[]; total: number;
  matchedBy: 'name' | 'appearance' | 'insufficient'; warnings: string[];
  page: SearchPagination;
}
export interface SearchPagination { offset: number; limit: number; total: number | null; hasMore: boolean; revision?: string }
export interface DrugSearchResult { candidates: DrugCandidate[]; warnings: string[]; page: SearchPagination }

export interface DrugSelection { source: DrugSource; id: string }
export interface DrugCandidate extends DrugSelection {
  name: string;
  englishName: string;
  ingredients: string[];
  dosageForm: string;
  manufacturer: string;
  licenseStatus: string;
  validUntil: string;
  indications: string;
  dosageText: string;
  sourceUrl: string;
  appearance?: DrugAppearance;
  appearanceOnly?: boolean;
}

export interface DatasetStatus {
  source: 'tfda' | 'ddinter' | 'tfda_appearance';
  count: number;
  importedAt: string | null;
  sourceUrl: string;
  license: string;
  coverage: string;
  fileName?: string;
  sha256?: string;
}

export const datasetNames: Record<DatasetStatus['source'], string> = {
  tfda: '臺灣藥品', ddinter: '交互作用', tfda_appearance: '藥品外觀',
};

export interface ResolvedIngredient {
  original: string;
  name: string;
  rxCui?: string;
  ddinterId?: string;
  mapping: 'exact' | 'rxnorm' | 'verified_alias' | 'unmapped';
  aliasSourceUrl?: string;
  ddinterNormalization?: {
    ddinterId: string; name: string; rxCui: string;
    checkedAt: string; version: string; lookupUrl: string; sourceUrl: string;
  };
  normalization?: {
    checkedAt: string; version: string; reused: boolean;
    matchedName: string; matchedRxCui: string;
    lookupUrl: string; sourceUrl: string;
  };
}

export interface LabelEvidence {
  id: string;
  setId?: string;
  version?: string;
  brandNames: string[];
  genericNames: string[];
  ingredients: string[];
  routes: string[];
  effectiveTime: string;
  sourceUrl: string;
  hasTables?: boolean;
  sections: { title: string; text: string; tables?: string[] }[];
}

export interface LabelLookup {
  textSectionsExpanded?: boolean;
  retrievedAt: string;
  sourceUrl: string;
  sourceUpdatedAt?: string;
  reused: boolean;
  refresh: 'not_requested' | 'cached' | 'succeeded' | 'failed';
  stale: boolean;
  scanned: number;
  total: number | null;
  complete: boolean;
}

export interface MedicationEvidence {
  drug: DrugCandidate;
  ingredients: ResolvedIngredient[];
  labels: LabelEvidence[];
  labelStatus: 'found' | 'not_found' | 'unavailable' | 'unmapped' | 'not_requested' | 'incomplete';
  labelLookup?: LabelLookup;
  warnings: string[];
  localLabel?: { title: string; sourceUrl: string; document?: SavedSourceDocument };
}

export interface InteractionEvidence {
  drugA: string;
  drugB: string;
  ingredientA: string;
  ingredientB: string;
  scope?: 'within_product' | 'between_products';
  status: 'found' | 'not_found' | 'unmapped' | 'not_imported' | 'duplicate';
  level?: string;
  sourceUrl: string;
  websiteSnapshot?: { retrievedAt: string; dataUrl: string };
  detail?: InteractionDetail;
  mechanism?: InteractionMechanism;
}

export interface MedicationReport {
  safety?: MedicationSafety;
  demo?: MedicationDemo;
  mode?: ReportMode;
  checkedAt: string;
  datasets: DatasetStatus[];
  medications: MedicationEvidence[];
  interactions: InteractionEvidence[];
  limitations: string[];
}

export const interactionStatusText: Record<InteractionEvidence['status'], string> = {
  found: '查得交互作用紀錄',
  not_found: '已匯入資料中未查得紀錄（不代表安全）',
  unmapped: '成分尚未完成對照，無法判定',
  not_imported: '尚未載入交互作用資料，無法判定',
  duplicate: '成分重複，請由藥師確認',
};

export const interactionLevelText: Record<string, string> = {
  Major: '重大', Moderate: '中度', Minor: '輕度', Unknown: '未知',
};

// Escape all source text before including it in a saved Markdown report.
export const escapeMarkdown = (value: string) => value.replace(/[\\`*_{}\[\]()<>#+.!|~-]/g, '\\$&');

// URL preserves existing % escapes; angle brackets keep parentheses inside the destination.
export const sourceMarkdownLink = (title: string, url: string) => `[${escapeMarkdown(title)}](<${new URL(url).href}>)`;

const savedDocumentMarkdown = (document?: SavedSourceDocument) => document && validLocalDocument(document)
  ? `[開啟本機 PDF 副本](${document.url}) · 取得時間：${escapeMarkdown(document.retrievedAt)} · SHA256：${document.sha256}。需在保存此副本的專案服務開啟；不是最新版本保證。` : '';

export function labelLookupNotes(lookup: LabelLookup): string[] {
  const notes = [`${lookup.reused ? '重用本機紀錄' : '已保存到本機'}；資料取得時間：${lookup.retrievedAt}。`];
  if (lookup.textSectionsExpanded === false) notes.push('此為舊版保存紀錄，可能缺少注意事項等文字段落。請使用「補查線上仿單與標準名稱」更新，或核對原始來源。');
  if (lookup.sourceUpdatedAt) notes.push(`openFDA 資料集更新日期：${lookup.sourceUpdatedAt}；個別仿單版本另列於下方。`);
  if (lookup.refresh === 'failed') notes.push('這次更新失敗，顯示先前保存的查詢結果，並非本次線上核對成功。');
  if (lookup.stale) notes.push('此紀錄已超過 7 天，請連線更新；這是專案更新提醒門檻，不是醫療有效期限。');
  notes.push(`已篩選 ${lookup.scanned} 筆${lookup.total === null ? '（來源未提供總筆數）' : `／搜尋結果共 ${lookup.total} 筆`}，最多顯示 2 份完整成分相符的仿單。${lookup.complete ? '' : '尚未篩選全部結果；沒有候選不代表沒有相符仿單。'}`);
  return notes;
}

export function reportToMarkdown(report: MedicationReport): string {
  const text = escapeMarkdown;
  const lines = ['## 藥物資料查詢報告', `查詢時間：${report.checkedAt}`, '',
    ...report.limitations.map(item => `- ${text(item)}`), ''];
  if (report.demo) lines.splice(2, 0, `### 教學示範：${text(report.demo.title)}`, text(report.demo.description),
    ...report.demo.notes.map(note => `- ${text(note)}`));
  if (report.safety) {
    const safety = report.safety;
    lines.push('### 年齡與併用提醒', `年齡：${patientAgeText(safety.patient)}；早產狀況：${({ unknown: '未提供', yes: '是（仍須專業確認）', no: '否' })[safety.patient.premature]}；來源查核日期：${safety.reviewedAt}`);
    for (const alert of safety.alerts) {
      lines.push(`#### ${safetyKindText[alert.kind]}：${text(alert.title)}`, text(alert.detail),
        ...alert.sources.flatMap(source => [`${sourceMarkdownLink(source.title, source.url)} · ${text(source.version)} · ${text(source.scope)}`, savedDocumentMarkdown(source.document)].filter(Boolean)));
    }
    if (safety.uncoveredDrugNames.length) lines.push(`尚無符合本次年齡的規則結論：${safety.uncoveredDrugNames.map(text).join('、')}。不代表安全。`);
    lines.push(...safety.limitations.map(text));
  }
  lines.push(report.safety ? '### 藥品明細' : '### 已確認的藥品');
  for (const entry of report.medications) {
    lines.push(`#### ${text(entry.drug.name)}`, `來源：[${entry.drug.source.toUpperCase()}](${entry.drug.sourceUrl}) · ${entry.drug.source === 'tfda' ? '許可證' : 'RxCUI'}：${text(entry.drug.id || '未提供')}`,
      `成分：${entry.ingredients.map(i => text(i.original)).join('、') || '未提供'}`,
      `標準對照：${entry.ingredients.map(i => `${text(i.name)}${i.rxCui ? `（RxCUI ${i.rxCui}）` : ''}${i.mapping === 'unmapped' ? '（未完成對照）' : ''}`).join('、')}`);
    if (entry.drug.licenseStatus) lines.push(`許可證狀態：${text(entry.drug.licenseStatus)}；有效日期：${text(entry.drug.validUntil || '未提供')}`);
    if (entry.drug.indications) lines.push(`TFDA 適應症原文：${text(entry.drug.indications)}`);
    if (entry.drug.appearance) {
      const a = entry.drug.appearance;
      lines.push(`外觀資料：${text([a.shape, a.color, a.score, a.size, a.imprint1, a.imprint2].filter(Boolean).join('／'))}。[TFDA 外觀資料](${a.sourceUrl})`);
      lines.push(...a.imageUrls.map((url, i) => `[原始外觀圖 ${i + 1}（需連線）](${url})`));
    }
    if (entry.drug.dosageText) lines.push(`TFDA 用法用量原文：${text(entry.drug.dosageText)}`);
    if (entry.localLabel) lines.push(`[${text(entry.localLabel.title)}](${entry.localLabel.sourceUrl})`, savedDocumentMarkdown(entry.localLabel.document));
    for (const ingredient of entry.ingredients) {
      if (ingredient.aliasSourceUrl) lines.push(`別名核對：${text(ingredient.original)} → ${text(ingredient.name)}。[核對來源](${ingredient.aliasSourceUrl})`);
      if (ingredient.ddinterNormalization) {
        const n = ingredient.ddinterNormalization;
        lines.push(`DDInter 名稱核對：${text(n.name)}（${text(n.ddinterId)}）與 ${text(ingredient.name)} 對應相同 RxCUI ${text(n.rxCui)}；重用本機紀錄，RxNorm ${text(n.version)}，核對日期 ${text(n.checkedAt)}。[精確名稱來源](${n.lookupUrl}) · [成分概念來源](${n.sourceUrl})`);
      }
      if (ingredient.normalization) {
        const n = ingredient.normalization;
        lines.push(`RxNorm 精確對照${n.reused ? '（重用本機紀錄）' : ''}：${text(ingredient.original)} → ${text(n.matchedName)} → ${text(ingredient.name)}；資料版本 ${text(n.version)}；核對時間 ${text(n.checkedAt)}。[精確名稱查詢](${n.lookupUrl}) · [成分關係來源](${n.sourceUrl})`);
      }
    }
    lines.push(...entry.warnings.map(w => `- ${text(w)}`));
    if (entry.labelLookup) lines.push(...labelLookupNotes(entry.labelLookup).map(text), `[仿單查詢來源](${entry.labelLookup.sourceUrl})`);
    if (!entry.labels.length) lines.push(`美國仿單：${entry.labelStatus === 'not_requested' ? '尚無本機保存紀錄，尚未查詢線上仿單' : entry.labelStatus === 'unavailable' ? '來源暫時無法連線' : entry.labelStatus === 'unmapped' ? '成分未完成標準對照' : entry.labelStatus === 'incomplete' ? '只完成部分篩選，尚未找到相符資料' : '該次查詢未查得符合成分的資料'}`);
    for (const label of entry.labels) {
      lines.push(`##### 相關美國仿單：${text(label.brandNames.join('、') || label.genericNames.join('、'))}`,
        `[原始資料](${label.sourceUrl}) · 仿單日期：${text(label.effectiveTime)} · 版本：${text(label.version || '未提供')} · SPL Set ID：${text(label.setId || '未提供')} · 給藥途徑：${text(label.routes.join('、'))}`,
        '僅供成分資料參考，未核對與所選產品的規格、劑型及核准用途；不是該臺灣產品的仿單。');
      for (const section of label.sections) {
        lines.push(`**${text(section.title)}（英文原文）**`, text(section.text));
        if (section.tables?.length) lines.push('原始資料表格（英文）；請一併閱讀本段文字與註記。僅供來源核對，不是個人用藥建議。',
          ...section.tables.map(html => sourceTableHtml(html) || sourceTableUnavailable));
      }
      if (label.hasTables && !label.sections.some(section => section.tables?.length)) lines.push('原始資料含表格；此為舊版保存紀錄，請重新分析或開啟原始資料核對表格。');
    }
    lines.push('');
  }
  lines.push('### 成分交互作用');
  if (!report.interactions.length) lines.push('目前沒有可比較的成分配對；這不代表用藥安全。');
  for (const pair of report.interactions) {
    lines.push(`- ${pair.scope === 'within_product' ? `同一品項的複方內：${text(pair.drugA)}` : `${text(pair.drugA)}／${text(pair.drugB)}`}：${text(pair.ingredientA)} + ${text(pair.ingredientB)} — ${interactionStatusText[pair.status]}${pair.level ? `；資料庫風險等級：${interactionLevelText[pair.level] || text(pair.level)}` : ''}。[資料來源](${pair.sourceUrl})`);
    if (pair.websiteSnapshot) lines.push(`  官方網站配對快照，已保存於本機；取得時間：${text(pair.websiteSnapshot.retrievedAt)}（非本次即時查詢、非個人風險機率）。[快照原始資料](${pair.websiteSnapshot.dataUrl})`);
    if (pair.mechanism) {
      const m = pair.mechanism;
      lines.push('**來源標示的影響方式**', ...m.types.map(type => `- ${text(mechanismDefinitions[type].label)}（${type}）：${text(mechanismDefinitions[type].description)}`),
        text(mechanismScope), `${sourceMarkdownLink('機轉分類來源', m.sourceUrl)} · ${sourceMarkdownLink('原始圖資料', m.dataUrl)} · 取得時間：${text(m.retrievedAt)}`,
        `${sourceMarkdownLink('DDInter 機轉分類定義', mechanismDefinitionUrl)}；中文為專案整理的一般詞義說明。原始快照 SHA256：${m.sha256}`);
    }
    if (pair.detail) {
      const d = pair.detail;
      if (d.summary) lines.push(`**簡明說明（專案依來源整理）**：${text(d.summary.text)}`, `整理日期：${text(d.summary.reviewedAt)}`);
      lines.push(text(interactionDetailScope), `${sourceMarkdownLink('DDInter 配對說明', d.sourceUrl)} · 已保存於本機 · 取得時間：${text(d.retrievedAt)}`,
        '**Interaction（來源原文）**', text(d.interaction), '**Management（來源原文，供專業核對）**', text(d.management));
      if (d.references.length) lines.push('**來源頁列出的參考文獻（未逐篇查核）**', ...d.references.map(text));
      lines.push(`來源內容 SHA256：${d.contentSha256}；原始頁面 SHA256：${d.sha256}`);
    }
  }
  lines.push('', '### 資料版本與涵蓋範圍');
  for (const dataset of report.datasets) lines.push(`- [${dataset.source.toUpperCase()}](${dataset.sourceUrl})：${dataset.count} 筆；匯入時間 ${dataset.importedAt || '尚未匯入'}；${text(dataset.coverage)}；授權 ${text(dataset.license)}`);
  return lines.join('\n\n');
}
