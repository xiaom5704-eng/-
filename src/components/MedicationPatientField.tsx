import { ageError, ageUnits, type AgeUnit } from '../../shared/consultation';
import { underYears, type MedicationPatient } from '../../shared/medication-safety';

export default function MedicationPatientField({ patient, disabled, onChange, onCompare, demo }: {
  patient: MedicationPatient; disabled: boolean; onChange: (patient: MedicationPatient) => void;
  onCompare: (patient: MedicationPatient) => void; demo: boolean;
}) {
  return <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-4">
    <div className="flex flex-wrap items-end gap-3">
      <label className="text-sm font-medium text-slate-700">用藥對象年齡<input aria-label="用藥對象年齡" inputMode="numeric" maxLength={5} placeholder="選填" value={patient.age.value} disabled={disabled} onChange={e => onChange({ ...patient, age: { ...patient.age, value: e.target.value }, premature: 'unknown' })} className="mt-1 block w-24 rounded-lg border border-slate-300 bg-white p-2" /></label>
      <label className="text-xs text-slate-600">單位<select aria-label="用藥年齡單位" value={patient.age.unit} disabled={disabled} onChange={e => onChange({ ...patient, age: { ...patient.age, unit: e.target.value as AgeUnit }, premature: 'unknown' })} className="mt-1 block rounded-lg border border-slate-300 bg-white p-2 text-sm">{Object.entries(ageUnits).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      {underYears(patient.age, 2) === true && <label className="text-xs text-slate-600">是否為早產兒<select aria-label="早產狀況" value={patient.premature} disabled={disabled} onChange={e => onChange({ ...patient, premature: e.target.value as MedicationPatient['premature'] })} className="mt-1 block rounded-lg border border-slate-300 bg-white p-2 text-sm"><option value="unknown">尚未確認</option><option value="no">否</option><option value="yes">是，需專業核對</option></select></label>}
    </div>
    <p className="mt-2 text-xs text-slate-500 leading-relaxed">適用各年齡；只核對已收錄的來源規則，不計算劑量。修改後請按「用本機資料分析」。未填年齡時不執行年齡核對。</p>
    {ageError(patient.age) && <p role="alert" className="mt-2 text-xs text-red-800">{ageError(patient.age)}</p>}
    {demo && <div className="mt-3 flex flex-wrap items-center gap-2"><span className="text-xs text-slate-500">切換示範年齡並分析</span>{[['1', 'months', '1 個月'], ['4', 'years', '4 歲'], ['30', 'years', '30 歲'], ['70', 'years', '70 歲']].map(([value, unit, text]) => <button key={text} type="button" disabled={disabled} onClick={() => onCompare({ age: { value, unit: unit as AgeUnit }, premature: 'unknown' })} className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700 hover:border-emerald-600 disabled:opacity-50">{text}</button>)}</div>}
  </div>;
}
