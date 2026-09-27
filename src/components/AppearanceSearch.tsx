import { useState } from 'react';
import type { MedicationObservation } from '../../shared/medication';

export default function AppearanceSearch({ disabled, onSearch, onEdit, initial }: { disabled: boolean; onSearch: (observation: MedicationObservation) => void; onEdit: () => void; initial?: MedicationObservation['appearance'] }) {
  const [shape, setShape] = useState(initial?.shape || '');
  const [color, setColor] = useState(initial?.color || '');
  const [front, setFront] = useState(initial?.imprints[0] || '');
  const [back, setBack] = useState(initial?.imprints[1] || '');
  const valid = front.trim() || back.trim() || (shape && color.trim());
  const field = 'mt-1 w-full rounded-lg border border-slate-300 p-2 text-sm';
  return <details open={initial ? true : undefined} className="mt-3 rounded-xl border border-emerald-100 bg-emerald-50/30 p-4">
    <summary className="cursor-pointer text-sm font-medium text-emerald-800">{initial ? 'AI 讀到的外觀：請先核對與修正' : '不用 AI：輸入刻字與外觀查本機資料'}</summary>
    <p className="text-xs text-slate-600 mt-2">{initial ? '請對照照片修正下方欄位，不確定就留空；模型可能誤讀刻字、顏色或形狀，尚未查詢或確認藥品。' : '輸入完整刻字，或同時提供顏色與形狀。'}資料可能有多個候選，仍需核對藥袋及原包裝。</p>
    <form className="mt-3" onChange={onEdit} onSubmit={e => { e.preventDefault(); if (valid && !disabled) onSearch({ name: '', strength: '', dosageForm: '', appearance: { shape, color: color.trim(), imprints: [front.trim(), back.trim()].filter(Boolean) } }); }}>
      <fieldset disabled={disabled} className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label className="text-xs">形狀<select className={field} value={shape} onChange={e => setShape(e.target.value)}><option value="">不確定／未提供</option>{['圓形', '橢圓形', '膠囊', '四邊形', '三角形', '五邊形', '六邊形', '八邊形', '水滴形', '雙圓形', '其他'].map(value => <option key={value}>{value}</option>)}</select></label>
        <label className="text-xs">顏色<input className={field} value={color} maxLength={120} placeholder="例如：白，或紅、白" onChange={e => setColor(e.target.value)} /></label>
        <label className="text-xs">正面刻字<input className={field} value={front} maxLength={120} placeholder="例如：FY T061" onChange={e => setFront(e.target.value)} /></label>
        <label className="text-xs">背面刻字（選填）<input className={field} value={back} maxLength={120} placeholder="只填看得清楚的字母與數字" onChange={e => setBack(e.target.value)} /></label>
      </fieldset>
      <button type="submit" disabled={disabled || !valid} className="mt-3 rounded-xl bg-emerald-700 px-4 py-2.5 text-sm text-white disabled:opacity-50">{initial ? '以核對後特徵查本機資料' : '查本機外觀資料'}</button>
    </form>
  </details>;
}
