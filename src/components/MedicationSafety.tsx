import { patientAgeText, safetyKindText, type MedicationSafety as Safety } from '../../shared/medication-safety';
import SourceDocument from './SourceDocument';

export default function MedicationSafety({ safety }: { safety: Safety }) {
  return <section className="rounded-2xl border border-amber-200 bg-white p-5 sm:p-6 space-y-4" aria-label="年齡與併用提醒">
    <div><p className="text-xs font-semibold text-amber-800">有來源的年齡核對 · {patientAgeText(safety.patient)}</p>
      <h4 className="mt-1 text-xl font-bold text-slate-900">先看這個年齡需要注意什麼</h4>
      <p className="mt-2 text-sm text-slate-600 leading-relaxed">依已收錄的仿單與資料規則核對。下方 DDInter 配對另行呈現；沒有提醒也不代表適用。</p>
    </div>
    {!safety.patient.age.value.trim() && <p className="rounded-xl bg-slate-100 p-3 text-sm">尚未提供年齡，未執行年齡條件核對。可回到查詢清單填寫。</p>}
    {safety.alerts.map(alert => <article key={alert.id} className={`rounded-xl border p-4 ${alert.kind === 'contraindication' ? 'border-red-200 bg-red-50' : alert.kind === 'missing' ? 'border-slate-200 bg-slate-50' : 'border-amber-100 bg-amber-50/60'}`}>
      <p className={`text-xs font-semibold ${alert.kind === 'contraindication' ? 'text-red-800' : 'text-slate-600'}`}>{safetyKindText[alert.kind]}</p>
      <h5 className="font-bold mt-1 text-slate-900">{alert.title}</h5>
      <p className="text-sm mt-2 leading-relaxed text-slate-700">{alert.detail}</p>
      <details className="mt-3 text-xs text-slate-600"><summary className="cursor-pointer underline underline-offset-4">查看品項與來源依據</summary>
        <p className="mt-2 break-words">{alert.drugNames.join('、')}</p>
        <ul className="mt-2 space-y-3">{alert.sources.map(source => <li key={source.url}>
          <a className="text-emerald-800 underline" href={source.url} target="_blank" rel="noreferrer">{source.title}</a>
          <p className="mt-1 leading-relaxed">{source.version} · {source.scope}</p>
          <SourceDocument saved={source.document} title={`${source.title}（${source.version}）`} sourceUrl={source.url} />
        </li>)}</ul>
      </details>
    </article>)}
    {!!safety.uncoveredDrugNames.length && <div className="text-sm leading-relaxed text-slate-600"><p className="font-semibold text-slate-800">仍需人工核對的部分</p><p className="mt-1">以下品項尚無符合本次年齡的規則結論：{safety.uncoveredDrugNames.join('、')}。這可能是未收錄規則或未觸發目前門檻，不能當作安全認證。</p></div>}
    <details className="text-xs text-slate-500"><summary className="cursor-pointer">提醒範圍與版本 · 查核 {safety.reviewedAt}</summary><ul className="mt-2 list-disc pl-4 space-y-2 leading-relaxed">{safety.limitations.map(item => <li key={item}>{item}</li>)}</ul></details>
  </section>;
}
