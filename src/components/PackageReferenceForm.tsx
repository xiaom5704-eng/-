import { useState } from 'react';

export default function PackageReferenceForm({ disabled, photoCount, onSave }: {
  disabled: boolean; photoCount: number; onSave: (productName: string, sourceNote: string) => void;
}) {
  const [name, setName] = useState('');
  const [source, setSource] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  return <details className="mt-3 rounded-xl border border-slate-200 bg-white p-3 text-sm">
    <summary className="cursor-pointer font-medium text-emerald-800">收錄已知藥盒，擴充本機圖庫</summary>
    <p className="mt-2 text-xs leading-relaxed text-slate-600">使用上方選取的 1–2 張同一藥盒照片。請先對照實物或藥師資料核對完整品名；不確定的照片請勿收錄。只有按下收錄才會儲存照片，一般比對不會儲存。</p>
    <form className="mt-3 space-y-3" onSubmit={event => { event.preventDefault(); if (!disabled && confirmed && photoCount >= 1 && photoCount <= 2) onSave(name.trim(), source.trim()); }}>
      <label className="block text-xs">完整品名（須與本機資料一致）<input required aria-label="收錄藥盒完整品名" disabled={disabled} value={name} minLength={2} maxLength={120} onChange={e => { setName(e.target.value); setConfirmed(false); }} placeholder="可先用下方藥名搜尋核對" className="mt-1 block w-full rounded-lg border border-slate-300 p-2 text-sm" /></label>
      <label className="block text-xs">照片來源<input required aria-label="藥盒照片來源" disabled={disabled} value={source} maxLength={300} onChange={e => { setSource(e.target.value); setConfirmed(false); }} placeholder="例如：自行拍攝，或提供照片的來源與授權" className="mt-1 block w-full rounded-lg border border-slate-300 p-2 text-sm" /></label>
      <label className="flex items-start gap-2 text-xs leading-relaxed"><input type="checkbox" disabled={disabled} checked={confirmed} onChange={e => setConfirmed(e.target.checked)} className="mt-0.5" />我已核對照片與完整品名，並確認這些照片可收錄於此專案。</label>
      <p className="text-xs text-slate-500">同名的不同許可證會保留為候選，不會憑包裝正面指定其中一張許可證。重新收錄相同照片不會重複累加。</p>
      <button type="submit" disabled={disabled || photoCount < 1 || photoCount > 2 || name.trim().length < 2 || !source.trim() || !confirmed} className="rounded-lg bg-emerald-700 px-4 py-2 text-sm text-white disabled:opacity-50">確認品名並收錄照片</button>
    </form>
  </details>;
}
