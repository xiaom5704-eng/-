import { ageError, ageLimits, ageUnits, type AgeUnit, type ConsultationAge } from '../../shared/consultation';

export default function ConsultationAgeField({ age, onChange, disabled }: {
  age: ConsultationAge; onChange: (age: ConsultationAge) => void; disabled: boolean;
}) {
  const error = ageError(age);
  return <section className="mb-5 rounded-2xl border border-emerald-100 bg-white p-4 sm:p-5">
    <div className="flex flex-wrap items-center gap-3">
      <label htmlFor="consultation-age" className="text-sm font-semibold text-slate-800">諮詢對象年齡</label>
      <div className="flex items-center gap-2">
        <input id="consultation-age" type="text" inputMode="numeric" value={age.value} disabled={disabled}
          placeholder="例如 30" maxLength={5} aria-invalid={!!error} aria-describedby="consultation-age-help consultation-age-error"
          onChange={e => onChange({ ...age, value: e.target.value })}
          className="w-24 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-emerald-500 disabled:opacity-60" />
        <select aria-label="年齡單位" value={age.unit} disabled={disabled} onChange={e => onChange({ ...age, unit: e.target.value as AgeUnit })}
          className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-emerald-500 disabled:opacity-60">
          {Object.entries(ageUnits).map(([unit, label]) => <option key={unit} value={unit}>{label}</option>)}
        </select>
      </div>
      {age.value && <button type="button" disabled={disabled} onClick={() => onChange({ value: '', unit: 'years' })} className="text-xs text-slate-500 underline disabled:opacity-60">清空欄位</button>}
    </div>
    <p id="consultation-age-help" className="mt-2 text-xs leading-5 text-slate-500">適用各年齡。未填時會參考本次問題或對話已提供的年齡；未滿 1 歲可填月齡或天數。請為不同的人建立新對話。</p>
    <p id="consultation-age-error" role={error ? 'alert' : undefined} className="text-xs text-red-700">{error && `${error}（此單位上限：${ageLimits[age.unit]}）`}</p>
  </section>;
}
