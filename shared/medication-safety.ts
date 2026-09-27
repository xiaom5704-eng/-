import { ageError, ageLimits, ageUnits, type ConsultationAge } from './consultation';
import type { DrugCandidate } from './medication';
import type { SavedSourceDocument } from './source-document';

export interface MedicationPatient { age: ConsultationAge; premature: 'unknown' | 'yes' | 'no' }
export interface SafetySource { title: string; url: string; version: string; scope: string; document?: SavedSourceDocument }
export interface SafetyAlert {
  id: string; kind: 'contraindication' | 'review' | 'missing' | 'overlap';
  title: string; detail: string; drugNames: string[]; sources: SafetySource[];
}
export interface MedicationSafety {
  patient: MedicationPatient; reviewedAt: string; alerts: SafetyAlert[]; uncoveredDrugNames: string[]; limitations: string[];
}
export const safetyKindText: Record<SafetyAlert['kind'], string> = {
  contraindication: '仿單禁忌條件符合', review: '需專業評估', missing: '資料待確認', overlap: '藥理重疊提醒・來源推論',
};
export const safetySources = {
  noscapine: { title: '甜嗽錠 20 mg 仿單（醫院公開）', url: 'https://www.hcch.org.tw/documents/20181/21570/甜嗽錠20mg.pdf/5bd08946-fe36-4a5d-a89b-f5dfa96bad21?version=1.0', version: '文件未標示版本日期', scope: '井田甜嗽錠：3 歲以下使用前洽醫師' },
  somin: { title: 'TFDA 藥品許可證資料', url: 'https://data.gov.tw/dataset/9122', version: '依本次本機資料版本', scope: '衛署藥製字第027569號之用法用量欄：3 歲以下不宜自行使用' },
  sominLabel: { title: '舒敏錠 2 mg 仿單（TFDA 公開）', url: 'https://mcp.fda.gov.tw/fileshow/trans0506804a0821-f508-48f5-a72b-00bb741b9db1', version: '平台檔名日期 2022-04-26；非最新版保證', scope: '衛署藥製字第027569號：使用注意、用法用量與警語' },
  cypromin: { title: '希普利敏液仿單（耕莘醫院公開）', url: 'https://www.cth.org.tw/public/medi_news/0c133454e62504eec2affd6144398c96.pdf', version: '2012-02-22；非最新版本保證', scope: '衛署藥製字第043588號：注意事項、藥理及交互作用' },
  cyprominUpdate: { title: '希普利敏液仿單（健仁醫院公開）', url: 'https://pha.jiannren.org.tw/pharmacy/pdf/OCYPRO.pdf', version: '2024-05-08', scope: '同許可證第 4 節：新生兒、早產兒等禁忌' },
  kbt: { title: '克瀉寧錠仿單（高雄榮總公開）', url: 'https://www2.vghks.gov.tw/DIWEB/dIDrug.do?hid=1A0&method=readFile&path=drugpdf/13354.pdf', version: '2023-02-24', scope: '內衛藥製字第007592號：成分、兒童使用及併用注意事項' },
  fencaine: { title: '芬康胃錠用藥資料（樂生婦幼醫院）', url: 'https://happybirth.com.tw/電子處方集/口服藥108.0410/Strocaine%2010mg_1081017.pdf', version: '2019-10-17', scope: '衛署藥製字第031990號之用藥資料；未提供嬰兒專用資訊' },
  fencaineLabel: { title: '芬康胃錠 10 mg 歷史仿單（TFDA 公開）', url: 'https://mcp.fda.gov.tw/insert/pdfcasefile/i_81d65748-468f-4410-a078-2d37a55dd757', version: '文件標記 MM 201511；平台歷史檔名日期 2015-12-29', scope: '衛署藥製字第031990號：僅列通常成人用量，未列兒童專用資訊' },
  dex: { title: 'DailyMed：dexchlorpheniramine 仿單', url: 'https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=aa4f80c9-e600-4bc0-8528-02a8162a36f0', version: '2024-01-08', scope: '美國口服液成分藥理參考，非 Somin 臺灣錠劑仿單；不可套用用量' },
  who: { title: 'WHO：新生兒定義', url: 'https://www.who.int/westernpacific/health-topics/newborn-health', version: '查核日期 2026-09-20', scope: '出生後前 28 天；月齡不能直接替代精確日齡' },
} satisfies Record<string, SafetySource>;

// License AND complete ingredient set must match. Dataset drift fails closed.
export const caseProducts = [
  { articleName: 'Noscapine', id: '衛署藥製字第038983號', ingredients: ['NOSCAPINE'], choice: '示範選用井田甜嗽錠 20 mg；文章僅列成分，未指定廠牌。' },
  { articleName: 'Somin', id: '衛署藥製字第027569號', ingredients: ['DEXCHLORPHENIRAMINE MALEATE'], choice: '示範選用永信舒敏錠 2 mg。' },
  { articleName: 'Cypromin', id: '衛署藥製字第043588號', ingredients: ['CYPROHEPTADINE HCL'], choice: '示範選用晟德希普利敏液 0.4 mg/mL；資料夾也有瑞士錠劑，不能互當同一產品。' },
  { articleName: 'K.B.T', id: '內衛藥製字第007592號', ingredients: ['BISMUTH SUBCARBONATE', 'SCOPOLIA EXTRACT', 'KAOLIN (WHITE)(BOLUS ALBA)', 'ALBUMIN TANNATE (TANNALBIN)'], choice: '克瀉寧錠為 4 成分複方；包含文章未列出的 Albumin tannate。' },
  { articleName: 'Fencaine', id: '衛署藥製字第031990號', ingredients: ['OXETHAZAINE'], choice: '示範選用優生芬康胃錠 10 mg。' },
] as const;
export const infantDemo = {
  id: 'infant-medication-review', title: '用藥核對示範（原案例：1 個月）',
  description: '依使用者提供的肚肚醫師文章藥名建立教學案例。以下是明列許可證的示範品項，未證實為原處方；未提供劑量、療程或完整病史。',
  sourceUrl: 'https://drive.google.com/drive/folders/1mjDv7QnI22Slb689Koru8uVtOREUHQKF',
  notes: [
    '此按鈕直接載入已選定的示範藥品，並非照片辨識的成功率展示。照片比對仍須另外實測。',
    'DDInter 配對與年齡／藥理提醒分開呈現；查無紀錄不能當作安全。',
    '碳酸鉍不是次水楊酸鉍；Scopolia extract 是萃取物，不能直接當成相同劑量的純 scopolamine。',
    '不以此案例判定猝死、腦病變、腸麻痺或原病例症狀的因果關係。',
  ],
};
export interface MedicationDemo { id: string; title: string; description: string; sourceUrl: string; notes: string[] }

export function matchesCaseProduct(drug: DrugCandidate, spec: { readonly id: string; readonly ingredients: readonly string[] }) {
  const names = drug.ingredients.map(name => name.normalize('NFKC').trim().toUpperCase()).sort();
  return drug.source === 'tfda' && drug.id === spec.id && names.length === spec.ingredients.length &&
    [...spec.ingredients].sort().every((name, i) => names[i] === name);
}
export function validMedicationPatient(value: unknown): value is MedicationPatient {
  if (!value || typeof value !== 'object') return false;
  const p = value as MedicationPatient;
  return !!p.age && typeof p.age.value === 'string' && p.age.value.length <= 5 &&
    Object.hasOwn(ageLimits, p.age.unit) && !ageError(p.age) && ['unknown', 'yes', 'no'].includes(p.premature);
}
export const patientAgeText = (patient: MedicationPatient) => patient.age.value.trim() ? `${Number(patient.age.value)} ${ageUnits[patient.age.unit]}` : '年齡未提供';

// Day-to-year comparisons near birthdays stay indeterminate. Never silently round
// 1 month to 30 days to decide a neonatal contraindication.
export function underYears(age: ConsultationAge, years: number): boolean | undefined {
  if (!age.value.trim() || ageError(age)) return undefined;
  const value = Number(age.value);
  if (age.unit === 'years') return value < years;
  if (age.unit === 'months') return value < years * 12;
  if (value < years * 365) return true;
  if (value >= years * 366) return false;
  return undefined;
}

export function evaluateMedicationSafety(drugs: DrugCandidate[], patient: MedicationPatient): MedicationSafety {
  if (!validMedicationPatient(patient)) throw new Error('用藥對象年齡或早產狀況格式無效。');
  const alerts: SafetyAlert[] = [];
  const covered = new Set<string>();
  const present = (index: number) => drugs.find(drug => matchesCaseProduct(drug, caseProducts[index]));
  const [noscapine, somin, cypromin, kbt, fencaine] = caseProducts.map((_, i) => present(i));
  const add = (id: string, kind: SafetyAlert['kind'], title: string, detail: string, meds: DrugCandidate[], sources: SafetySource[]) => {
    alerts.push({ id, kind, title, detail, drugNames: meds.map(drug => drug.name), sources });
  };
  const age = patient.age;
  if (age.value.trim()) {
    if (noscapine && underYears(age, 3) === true) {
      covered.add(noscapine.id);
      add('noscapine-under3', 'review', 'Noscapine：未滿 3 歲須先由醫師評估', '甜嗽錠仿單要求 3 歲以下使用前洽醫師診治。這不是可按成人劑量縮小使用的許可，也不等同一律禁用。', [noscapine], [safetySources.noscapine]);
    }
    if (somin && underYears(age, 3) === true) {
      covered.add(somin.id);
      add('somin-under3', 'review', 'Somin：未滿 3 歲不宜自行使用', '所選舒敏錠的公開仿單要求 3 歲以下使用前洽醫師診治。不要將其他品牌、劑型或其他年齡的用量套用於此對象。', [somin], [safetySources.sominLabel]);
    }
    if (cypromin && underYears(age, 2) === true) {
      covered.add(cypromin.id);
      add('cypromin-under2', 'missing', 'Cypromin：仿單未建立 2 歲以下用量', '耕莘公開的該品項仿單記載未建立 2 歲以下用量；此為 2012 版資料，需核對現行仿單。系統不據此推算嬰兒用量。', [cypromin], [safetySources.cypromin]);
      const exactNeonate = age.unit === 'days' && Number(age.value) < 28;
      if (exactNeonate) add('cypromin-neonate', 'contraindication', 'Cypromin：符合新生兒禁用條件', '填寫日齡未滿 28 天，對應新生兒定義；所選希普利敏液仿單列新生兒禁用。請由醫師或藥師核對處方。', [cypromin], [safetySources.cyprominUpdate, safetySources.who]);
      else if ((age.unit === 'months' && Number(age.value) <= 1) || (age.unit === 'years' && Number(age.value) === 0))
        add('confirm-day-age', 'missing', '先確認實際日齡', '「一個月」不自動判定為未滿 28 天。請改填出生後天數，再核對新生兒禁忌；超過 28 天也不代表此藥適用。', [cypromin], [safetySources.who, safetySources.cyprominUpdate]);
      if (patient.premature !== 'no') add('confirm-prematurity', 'missing', patient.premature === 'yes' ? '早產兒禁忌需優先核對' : '尚未確認早產狀況', '所選希普利敏液仿單列早產兒禁用。需由醫療人員結合出生週數與目前狀況確認；系統不以出生史自動判定終身禁用。', [cypromin], [safetySources.cyprominUpdate]);
    }
    if (kbt && underYears(age, 18) === true) {
      covered.add(kbt.id);
      add('kbt-child', 'review', 'K.B.T：兒童使用前須洽醫師', '仿單要求兒童使用前洽醫師，並提醒腹脹、腹痛等情況需診治。這是四成分複方，不只含鉍劑；系統不將碳酸鉍套用次水楊酸鉍的警語。', [kbt], [safetySources.kbt]);
    }
    if (fencaine && underYears(age, 18) === true) {
      add('fencaine-gap', 'missing', 'Fencaine：尚缺這個年齡的完整依據', '已核對成分為 oxethazaine。TFDA 公開的歷史仿單僅列通常成人用量，未提供兒童或嬰兒專用資訊。不能按成人用量縮小推算，也不能據此證明會造成腸麻痺；仍需核對現行仿單與專業評估。', [fencaine], [safetySources.fencaineLabel]);
    }
    if (somin && underYears(age, 65) === false) {
      covered.add(somin.id);
      add('somin-older', 'review', 'Somin：65 歲以上使用前先諮詢醫師或藥師', '所選舒敏錠仿單要求 65 歲以上使用前先諮詢醫師或藥師，並提醒可能嗜睡。這是使用前評估的提醒，不等同只憑年齡判定禁用。', [somin], [safetySources.sominLabel]);
    }
    if (cypromin && underYears(age, 65) === false) {
      covered.add(cypromin.id);
      add('cypromin-older', 'review', 'Cypromin：高齡者需核對鎮靜與低血壓風險', '公開仿單提醒老年人較易眩暈、鎮靜或低血壓，且年老虛弱者禁用。系統以 65 歲作提醒門檻；年齡本身不能判定是否虛弱或是否禁用。', [cypromin], [safetySources.cypromin]);
    }
  }
  if (somin && cypromin) add('sedation-overlap', 'overlap', 'Somin ＋ Cypromin：需核對鎮靜與抗膽鹼作用重疊', '兩種不同成分都有鎮靜及抗膽鹼作用。依來源藥理推論，併用需由藥師評估作用累加；這不是相同成分重複，也不是個人風險機率。DDInter 配對查詢結果另列於下方。', [somin, cypromin], [safetySources.dex, safetySources.cypromin]);
  if (kbt && drugs.length > 1) add('kbt-coadministration', 'review', 'K.B.T：仿單另有與其他藥品併用的提醒', '該品項仿單提醒與其他藥品至少間隔 3 小時。此處呈現核對重點，實際服藥時間須由藥師確認，勿直接據此自行排程。', [kbt], [safetySources.kbt]);
  return { patient, reviewedAt: '2026-09-24', alerts, uncoveredDrugNames: drugs.filter(drug => !covered.has(drug.id)).map(drug => drug.name), limitations: [
    '這是有限品項的來源規則，不是完整臨床用藥審查；沒有觸發提醒不代表安全。未納入劑量、體重、療程、疾病與其他用藥。',
    '年齡提醒與 DDInter 結果分開；不改寫資料庫風險等級，也不推算個人劑量。',
    '來源版本與適用產品均列於各提醒；部分公開資料較舊，使用前仍須核對最新仿單。來源查核不等於醫療專業審核。',
    '兒童分流的未滿 18 歲與 Cypromin 高齡提醒的 65 歲，屬專案人工核對門檻；Somin 的 65 歲門檻依該品項仿單。這些都不是通用禁用界線；日齡接近生日門檻時須改填足歲／足月。',
  ] };
}
