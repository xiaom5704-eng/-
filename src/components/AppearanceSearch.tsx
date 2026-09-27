import { useState } from 'react';
import type { MedicationObservation } from '../../shared/medication';
import { appearanceTerms, type AppearanceOptions } from '../../shared/appearance-search';

export default function AppearanceSearch({ disabled, onSearch, onEdit, initial, options }: { disabled: boolean; onSearch: (observation: MedicationObservation) => void; onEdit: () => void; initial?: MedicationObservation['appearance']; options?: AppearanceOptions }) {
  const [shape, setShape] = useState(initial?.shape || '');
  const [color, setColor] = useState(initial?.color || '');
  const [front, setFront] = useState(initial?.imprints[0] || '');
  const [back, setBack] = useState(initial?.imprints[1] || '');
  const valid = front.trim() || back.trim() || (shape && color.trim());
  const shapes = [...new Set([...(options?.shapes || []), ...(shape ? [shape] : [])])];
  const colors = appearanceTerms(color, 'color');
  const toggleColor = (value: string) => {
    setColor((colors.includes(value) ? colors.filter(item => item !== value) : [...colors, value]).join('、'));
    onEdit();
  };
  const field = 'mt-1 w-full rounded-lg border border-slate-300 p-2 text-sm';
  return <details open={initial ? true : undefined} className="mt-3 rounded-xl border border-emerald-100 bg-emerald-50/30 p-4">
    <summary className="cursor-pointer text-sm font-medium text-emerald-800">{initial ? 'AI 讀到的外觀：請先核對與修正' : '不用 AI：輸入刻字與外觀查本機資料'}</summary>
    <p className="text-xs text-slate-600 mt-2">{initial ? '請對照照片修正下方欄位，不確定就留空；模型可能誤讀刻字、顏色或形狀，尚未查詢或確認藥品。' : '輸入完整刻字，或同時提供顏色與形狀。'}資料可能有多個候選，仍需核對藥袋及原包裝。</p>
    <form className="mt-3" onChange={onEdit} onSubmit={e => { e.preventDefault(); if (valid && !disabled) onSearch({ name: '', strength: '', dosageForm: '', appearance: { shape, color: color.trim(), imprints: [front.trim(), back.trim()].filter(Boolean) } }); }}>
      <fieldset disabled={disabled} className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label className="text-xs">形狀／外觀類型<select className={field} value={shape} onChange={e => setShape(e.target.value)}><option value="">不確定／未提供</option>{shapes.map(value => <option key={value}>{value}</option>)}</select></label>
        <div className="text-xs">
          <label>顏色<input className={field} value={color} maxLength={120} placeholder="可點選下方顏色，例如：白、粉" onChange={e => setColor(e.target.value)} /></label>
          {!!options?.colors.length && <div role="group" aria-label="本機顏色選項" className="mt-2 flex flex-wrap gap-1.5">{options.colors.map(value => <button key={value} type="button" aria-pressed={colors.includes(value)} onClick={() => toggleColor(value)} className={`rounded-lg border px-2.5 py-1.5 ${colors.includes(value) ? 'border-emerald-700 bg-emerald-100 text-emerald-900' : 'border-slate-300 bg-white text-slate-700'}`}>{value}</button>)}</div>}
          <p className="mt-2 text-slate-600">選項使用本機資料的用字；可複選顏色，查詢時須同時符合。再次點選可取消，不確定就留空。</p>
        </div>
        <label className="text-xs">正面刻字<input className={field} value={front} maxLength={120} placeholder="例如：FY T061" onChange={e => setFront(e.target.value)} /></label>
        <label className="text-xs">背面刻字（選填）<input className={field} value={back} maxLength={120} placeholder="只填看得清楚的字母與數字" onChange={e => setBack(e.target.value)} /></label>
      </fieldset>
      {!options?.shapes.length && <p className="mt-2 text-xs text-slate-600">本機外觀選項尚未載入，可按上方「重新讀取資料狀態」。仍可輸入完整刻字查詢。</p>}
      <button type="submit" disabled={disabled || !valid} className="mt-3 rounded-xl bg-emerald-700 px-4 py-2.5 text-sm text-white disabled:opacity-50">{initial ? '以核對後特徵查本機資料' : '查本機外觀資料'}</button>
    </form>
  </details>;
}
