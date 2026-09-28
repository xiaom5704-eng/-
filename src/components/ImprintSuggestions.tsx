import { useEffect, useRef, useState } from 'react';
import type { MedicationObservation } from '../../shared/medication';
import { applyImprintSuggestion, imprintDifference, type ImprintSuggestions as Result } from '../../shared/imprint-suggestions';
import { suggestMedicationImprints } from '../services/medications';

export default function ImprintSuggestions({ observation, disabled, active, onSearch }: {
  observation: MedicationObservation; disabled: boolean; active: boolean;
  onSearch: (observation: MedicationObservation, notice: string) => void;
}) {
  const [result, setResult] = useState<Result | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef<AbortController | null>(null);
  useEffect(() => {
    if (!active) { pending.current?.abort(); setLoading(false); }
    return () => { pending.current?.abort(); };
  }, [active]);
  async function load() {
    if (disabled || loading) return;
    const controller = new AbortController(); pending.current = controller;
    setLoading(true); setError('');
    try { const data = await suggestMedicationImprints(observation, controller.signal); if (!controller.signal.aborted) setResult(data); }
    catch (e) { if (!controller.signal.aborted) setError((e as Error).message); }
    finally { if (!controller.signal.aborted) setLoading(false); }
  }
  const button = 'rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700 disabled:opacity-50';
  return <section aria-label="相近刻字對照" className="mt-3 rounded-xl border border-amber-200 bg-amber-50/50 p-4 text-sm">
    <p className="font-medium text-slate-900">刻字可能讀錯了？對照資料庫中的寫法</p>
    <p className="mt-1 text-slate-700">只列出與完整刻字相差一個英文字母或數字的紀錄，最多 8 組。這不是照片辨識結果，排序不代表正確率。請先看原圖核對，再改查；原文字與其他條件會保留。</p>
    {!result && <button type="button" className={`${button} mt-3`} disabled={disabled || loading} onClick={() => void load()}>{loading ? '正在查詢刻字紀錄…' : '查看相近刻字'}</button>}
    {loading && <p role="status" className="mt-2 text-slate-600">正在本機查詢，尚未更改原結果。</p>}
    {error && <p role="alert" className="mt-2 text-red-800">{error}</p>}
    {result && <>
      {!result.suggestions.length && <p className="mt-3 text-slate-700">沒有找到符合其他條件的相近刻字。可補拍清楚近照、核對正反面，或從藥袋／外盒查完整品名；不代表此藥不存在。</p>}
      <ul className="mt-3 space-y-2">{result.suggestions.map(item => {
        const original = observation.appearance!.imprints[item.index], difference = imprintDifference(original, item.text)!;
        return <li key={`${item.index}:${item.text}`} className="rounded-lg border border-amber-100 bg-white p-3">
          <p className="break-words">原查詢「{original}」 → 紀錄「<strong>{item.text}</strong>」</p>
          <p className="mt-1 text-xs text-slate-600">第 {difference.position} 個字元不同：{difference.from} → {difference.to}（忽略空白及大小寫）。改查後有 {item.count} 個候選，仍未確認藥品。</p>
          <button type="button" className={`${button} mt-2`} disabled={disabled || loading} onClick={() => onSearch(applyImprintSuggestion(observation, item), `本次依您點選的刻字「${item.text}」重新查詢，原查詢為「${original}」。請再次對照照片、藥袋與完整品名；尚未確認藥品。`)}>已核對，改查「{item.text}」</button>
        </li>;
      })}</ul>
      {result.hasMore && <p className="mt-2 text-xs text-slate-600">相近寫法超過 8 組，目前僅列部分；請補充其他清楚特徵，或改查藥袋上的品名。</p>}
    </>}
  </section>;
}
