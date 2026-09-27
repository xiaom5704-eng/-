import { useState } from 'react';
import type { DrugCandidate } from '../../shared/medication';
import { canCollectPillReference, type PersonalPillLibrary } from '../../shared/pill-references';
import PackageReferenceImages from './PackageReferenceImages';

export default function PillReferenceLibrary({ selected, photoCount, disabled, library, onSave, onDisable, onRefresh }: {
  selected: DrugCandidate[]; photoCount: number; disabled: boolean; library: PersonalPillLibrary | null;
  onSave: (drug: DrugCandidate, note: string) => void; onDisable: (key: string) => void; onRefresh: () => void;
}) {
  const [id, setId] = useState(''), [note, setNote] = useState(''), [confirmed, setConfirmed] = useState(false);
  const choices = selected.filter(canCollectPillReference), drug = choices.find(item => item.id === id);
  return <details className="mt-3 rounded-xl border border-slate-200 bg-white p-3 text-sm">
    <summary className="cursor-pointer font-medium text-emerald-800">收錄與管理已核對的藥錠照片</summary>
    <p className="mt-2 text-xs leading-relaxed text-slate-600">先用下方藥名／許可證搜尋，核對後按「確認並分析」，再選擇照片對應的品項。只收錄上方 1–2 張同一種藥的照片，請用實物、藥袋或藥師資料核對；不能只憑 AI 候選確認。</p>
    <form className="mt-3 space-y-3" onSubmit={event => { event.preventDefault(); if (!disabled && confirmed && drug && photoCount >= 1 && photoCount <= 2 && note.trim()) onSave(drug, note.trim()); }}>
      <label className="block text-xs">照片對應的已確認品項<select aria-label="收錄藥錠品項" required disabled={disabled} value={id} onChange={event => { setId(event.target.value); setConfirmed(false); }} className="mt-1 block w-full rounded-lg border border-slate-300 bg-white p-2 text-sm">
        <option value="">{choices.length ? '請選擇並核對許可證' : '請先搜尋並確認藥錠品項'}</option>
        {choices.map(item => <option key={item.id} value={item.id}>{item.name} · {item.id}</option>)}
      </select></label>
      {drug && <div className="rounded-lg bg-slate-50 p-3 text-xs leading-relaxed break-words"><p className="font-semibold">{drug.name}</p><p>{drug.englishName}</p><p>{drug.id} · {drug.dosageForm}</p><p>成分：{drug.ingredients.join('、')}</p><p>製造商：{drug.manufacturer || '來源未提供'}</p></div>}
      <label className="block text-xs">照片來源與核對依據<input aria-label="藥錠照片來源" required maxLength={300} disabled={disabled} value={note} onChange={event => { setNote(event.target.value); setConfirmed(false); }} placeholder="例如：自行拍攝，已依原包裝許可證核對；勿填病人個資" className="mt-1 block w-full rounded-lg border border-slate-300 p-2 text-sm" /></label>
      <label className="flex items-start gap-2 text-xs leading-relaxed"><input type="checkbox" disabled={disabled || !drug} checked={confirmed} onChange={event => setConfirmed(event.target.checked)} className="mt-0.5" />我已核對照片與此許可證的品項相符，並同意將有權使用的照片存入本機圖庫。</label>
      <p className="text-xs leading-relaxed text-slate-500">按收錄才會保存照片及來源文字；一般比對不保存。照片只留在本專案後端，不送 Gemini。相同照片與許可證不重複累加，仍須人工核對後續候選。</p>
      <button type="submit" disabled={disabled || !drug || !confirmed || !note.trim() || photoCount < 1 || photoCount > 2} className="rounded-lg bg-emerald-700 px-4 py-2 text-sm text-white disabled:opacity-50">確認許可證並收錄藥錠照片</button>
    </form>
    <div className="mt-4 border-t pt-3">
      <div className="flex flex-wrap items-center justify-between gap-2"><p className="font-medium">自存藥錠照片 {library ? `（${library.photos.filter(photo => photo.usable).length} 張可用）` : ''}</p><button type="button" disabled={disabled} onClick={onRefresh} className="text-xs text-emerald-800 underline">重新讀取自存照片</button></div>
      {library?.warning && <p role="status" className="mt-2 text-xs text-amber-800">{library.warning}</p>}
      {!library ? <p className="mt-2 text-xs text-slate-500">正在讀取…</p> : !library.photos.length && !library.warning ? <p className="mt-2 text-xs text-slate-500">尚未收錄；既有官方參考圖仍照常使用。</p> : null}
      <ul className="mt-2 max-h-96 space-y-3 overflow-y-auto">{library?.photos.map(photo => <li key={photo.key} className="rounded-lg border border-slate-200 p-3">
        <p className="text-xs font-semibold break-words">{photo.name}</p><p className="text-xs text-slate-500">{photo.drugId} · {new Date(photo.createdAt).toLocaleDateString('zh-TW')}</p>
        {photo.imageUrl ? <PackageReferenceImages name={photo.name} kind="pill" images={[{ url: photo.imageUrl, sourceUrl: '', sourceNote: photo.sourceNote, provenance: 'personal' }]} /> : <p className="mt-1 text-xs text-slate-500 break-words">來源：{photo.sourceNote}</p>}
        {photo.reason && <p className="mt-2 text-xs text-amber-800">{photo.reason}</p>}
        {!photo.disabled && <button type="button" disabled={disabled} onClick={() => onDisable(photo.key)} className="mt-2 rounded-lg border border-slate-300 px-3 py-1.5 text-xs">停用這張照片</button>}
      </li>)}</ul>
      <p className="mt-2 text-xs text-slate-500">停用後立即排除比對，檔案仍留在本機。重新核對並收錄相同照片即可恢復；自存照片不會加入公開下載資料。</p>
    </div>
  </details>;
}
