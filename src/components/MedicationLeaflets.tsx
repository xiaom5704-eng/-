import { ExternalLink, FileText } from 'lucide-react';
import type { MedicationEvidence, MedicationReport } from '../../shared/medication';
import { labelLookupNotes } from '../../shared/medication';
import { ingredientName } from '../../shared/medication-view';
import DrugAppearanceDetails from './DrugAppearanceDetails';
import SourceTables from './SourceTables';
import SourceDocument from './SourceDocument';
import TaiwanLabelLinks from './TaiwanLabelLinks';

const labelStatus: Record<MedicationEvidence['labelStatus'], string> = {
  found: '有成分相符的美國資料可參考',
  not_found: '保存的該次查詢沒有找到完整成分相符的美國仿單，請核對取得日期。',
  incomplete: '只完成部分結果的篩選，目前還沒找到完整成分相符的仿單，不能當作查無資料。',
  unavailable: '美國仿單服務暫時無法連線，請稍後重新查詢。',
  unmapped: '部分成分名稱尚未核對完成，暫時無法查詢美國仿單。',
  not_requested: '尚無可重用的本機仿單紀錄。如有需要，可按「補查線上仿單與標準名稱」，查得的資料會保存供之後離線查看。',
};
const sectionNames: Record<string, string> = { 適應症: '這個藥用來做什麼', 用法用量: '如何使用', 兒童使用資訊: '兒童使用須知', 高齡者使用資訊: '高齡者使用須知', 特定族群使用資訊: '特定族群使用須知', 禁忌: '哪些情況不宜使用', 交互作用: '與其他藥一起使用', 警語: '使用時要注意什麼', 警語與注意事項: '警語與注意事項' };
const labelDate = (date: string) => /^\d{8}$/.test(date) ? `${date.slice(0, 4)}/${date.slice(4, 6)}/${date.slice(6)}` : date;

export default function MedicationLeaflets({ report, onPackageChange }: { report: MedicationReport; onPackageChange?: () => void }) {
  return <div className="space-y-4">
    <div><h4 className="text-xl font-bold text-slate-900">每款藥，分開看清楚</h4><p className="text-sm text-slate-600 mt-2 leading-relaxed">先看臺灣藥品資料；完整說明書與英文參考資料可再展開。</p></div>
    {report.medications.map(entry => <article key={`${entry.drug.source}:${entry.drug.id}`} className="rounded-2xl border border-slate-200 bg-white p-5 sm:p-6 space-y-4">
      <div className="flex items-start gap-3"><span className="rounded-xl bg-emerald-50 p-2 text-emerald-700"><FileText size={20} aria-hidden="true" /></span><div className="min-w-0"><h5 className="font-bold text-lg text-slate-900 break-words">{entry.drug.name}</h5><p className="text-xs text-slate-500 mt-1">{entry.drug.dosageForm} · {entry.drug.source === 'tfda' ? '臺灣藥品' : '美國標準藥名'}</p></div></div>
      {entry.warnings.filter(w => /許可證|有效日期/.test(w)).map(w => <p key={w} className="text-sm text-amber-900 rounded-xl bg-amber-50 p-3">{w}</p>)}
      <div><h6 className="font-semibold text-sm text-slate-800">這個藥的用途</h6><p className="text-sm leading-7 text-slate-600 mt-1">{entry.drug.indications || '目前來源未提供用途說明，請查看原始仿單。'}</p>{entry.drug.indications && <p className="text-xs text-slate-400 mt-1">食藥署適應症原文</p>}</div>
      {entry.drug.appearance && <DrugAppearanceDetails appearance={entry.drug.appearance} drugName={entry.drug.name} licenseId={entry.drug.id} />}
      {entry.localLabel ? <div className="rounded-xl bg-emerald-50 p-4">
        <a href={entry.localLabel.sourceUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 text-sm font-semibold text-emerald-800 underline underline-offset-4">開啟臺灣仿單來源（需連線） <ExternalLink size={15} aria-hidden="true" /></a>
        <p className="text-xs text-emerald-900 mt-2 leading-relaxed">{entry.localLabel.title}</p>
        <SourceDocument saved={entry.localLabel.document} title={entry.localLabel.title} sourceUrl={entry.localLabel.sourceUrl} />
      </div> : !entry.taiwanLabelIndex && entry.drug.source === 'tfda' && <p className="text-sm text-slate-500 leading-relaxed">本機索引尚未找到許可證及品名都相符的臺灣仿單入口，請查看藥盒內的說明書或詢問藥師。</p>}
      {entry.taiwanLabelIndex && <TaiwanLabelLinks entry={entry.taiwanLabelIndex} onPackageChange={onPackageChange} />}
      {entry.drug.dosageText && entry.drug.dosageText !== '詳見仿單' && <details className="rounded-xl bg-slate-50 p-3"><summary className="cursor-pointer text-sm font-medium">如何使用（食藥署原文）</summary><p className="whitespace-pre-wrap text-sm leading-7 mt-3">{entry.drug.dosageText}</p></details>}
      <details className="border-t border-slate-100 pt-4">
        <summary className="cursor-pointer text-sm font-medium text-slate-700">美國仿單參考{entry.labels.length ? `（${entry.labels.length} 份・英文${entry.labelLookup?.reused ? '・本機紀錄' : ''}）` : entry.labelStatus === 'not_requested' ? '（尚無保存紀錄）' : entry.labelStatus === 'unavailable' ? '（暫時無法連線）' : entry.labelStatus === 'unmapped' ? '（成分待核對）' : entry.labelStatus === 'incomplete' ? '（尚未完成篩選）' : '（該次未查得相符資料）'}</summary>
        <p className="text-sm text-amber-900 mt-3 leading-relaxed">這些資料只按成分尋找，未核對規格、劑型與用途，不能直接套用用法與用量。</p>
        {entry.labelLookup && <div className="rounded-xl bg-slate-50 p-3 mt-3 space-y-1 text-xs text-slate-600 leading-relaxed">
          {labelLookupNotes(entry.labelLookup).map(note => <p key={note}>{note}</p>)}
          <a href={entry.labelLookup.sourceUrl} target="_blank" rel="noreferrer" className="inline-block text-emerald-800 underline">核對原查詢來源（需連線）</a>
        </div>}
        {!entry.labels.length && <p className="text-sm text-slate-600 mt-3">{labelStatus[entry.labelStatus]}</p>}
        <div className="space-y-3 mt-3">{entry.labels.map(label => <div key={label.id} className="rounded-xl border border-slate-200 p-4">
          <p className="text-sm font-semibold break-words">{label.brandNames.join('、') || label.genericNames.join('、')}</p>
          <p className="text-xs text-slate-500 mt-3 leading-relaxed">仿單日期：{labelDate(label.effectiveTime)} · 版本：{label.version || '未提供'} · 給藥途徑：{label.routes.join('、') || '未提供'}<br />成分：{label.ingredients.join('、')}{label.setId && <><br />SPL Set ID：{label.setId}</>}</p>
          {['兒童使用資訊', '高齡者使用資訊'].filter(title => !label.sections.some(s => s.title === title)).length > 0 && <p className="text-xs text-slate-600 mt-3">此份資料未提供獨立的{['兒童使用資訊', '高齡者使用資訊'].filter(title => !label.sections.some(s => s.title === title)).join('、')}段落；其他段落仍可能含年齡限制，請核對完整仿單。</p>}
          {label.sections.map(section => <details key={section.title} className="border-t border-slate-100 mt-3 pt-3"><summary className="cursor-pointer text-sm text-slate-700">{sectionNames[section.title] || section.title}（英文原文）{section.tables?.length ? ' · 含表格' : ''}</summary>{section.text && <p className="text-sm text-slate-700 whitespace-pre-wrap break-words leading-7 mt-3">{section.text}</p>}{!!section.tables?.length && <SourceTables tables={section.tables} />}</details>)}
          {label.hasTables && !label.sections.some(section => section.tables?.length) && <p className="text-xs text-slate-600 mt-3 leading-relaxed">原始資料含表格；此為舊版保存紀錄，請重新分析或開啟原始資料核對表格。</p>}
          <a href={label.sourceUrl} target="_blank" rel="noreferrer" className="text-xs text-emerald-800 underline inline-block mt-4">檢視 openFDA 原始資料 <ExternalLink size={12} className="inline" aria-hidden="true" /></a>
        </div>)}</div>
      </details>
      <details className="border-t border-slate-100 pt-4 text-sm">
        <summary className="cursor-pointer font-medium text-slate-700">成分、核對狀態與來源</summary>
        <div className="mt-3 space-y-3 text-slate-600">
          {entry.ingredients.map((ingredient, i) => <div key={i} className="break-words leading-relaxed">
            <p className="font-medium">{ingredientName(ingredient)}</p><p className="text-xs">{ingredient.original} → {ingredient.name}{ingredient.rxCui && `（RxCUI ${ingredient.rxCui}）`}</p>
            {!ingredient.ddinterId && <p className="text-xs text-amber-900">{ingredient.rxCui ? '已核對標準成分，但本機 DDInter 尚無可對應名稱，仍無法判定交互作用。' : '交互作用資料尚未完成對照'}</p>}
            {ingredient.normalization && <div className="mt-2 text-xs leading-relaxed">
              <p>{ingredient.normalization.reused ? '重用本機核對紀錄' : '已保存精確對照'} · RxNorm {ingredient.normalization.version}</p>
              <p>核對日期：{ingredient.normalization.checkedAt.slice(0, 10)} · 原概念：{ingredient.normalization.matchedName}</p>
              <a href={ingredient.normalization.lookupUrl} target="_blank" rel="noreferrer" className="text-emerald-800 underline mr-3">精確名稱來源</a>
              <a href={ingredient.normalization.sourceUrl} target="_blank" rel="noreferrer" className="text-emerald-800 underline">成分關係來源</a>
            </div>}
            {ingredient.aliasSourceUrl && <a href={ingredient.aliasSourceUrl} target="_blank" rel="noreferrer" className="text-xs text-emerald-800 underline">名稱核對來源</a>}
            {ingredient.ddinterNormalization && <div className="mt-2 text-xs leading-relaxed">
              <p>交互作用資料使用名稱：{ingredient.ddinterNormalization.name}（{ingredient.ddinterNormalization.ddinterId}）</p>
              <p>兩個名稱精確對應相同 RxCUI {ingredient.ddinterNormalization.rxCui} · 重用本機紀錄</p>
              <p>RxNorm {ingredient.ddinterNormalization.version} · 核對日期：{ingredient.ddinterNormalization.checkedAt.slice(0, 10)}</p>
              <a href={ingredient.ddinterNormalization.lookupUrl} target="_blank" rel="noreferrer" className="text-emerald-800 underline mr-3">DDInter 名稱對照來源</a>
              <a href={ingredient.ddinterNormalization.sourceUrl} target="_blank" rel="noreferrer" className="text-emerald-800 underline">成分概念來源</a>
            </div>}
          </div>)}
          {entry.warnings.map(w => <p key={w} className="text-xs text-amber-900 leading-relaxed">{w}</p>)}
          {entry.drug.dosageText && <p className="text-xs">食藥署用法用量欄位：{entry.drug.dosageText}</p>}
          <a href={entry.drug.sourceUrl} target="_blank" rel="noreferrer" className="text-xs text-emerald-800 underline break-words">{entry.drug.source.toUpperCase()} · {entry.drug.id}</a>
        </div>
      </details>
    </article>)}
  </div>;
}
