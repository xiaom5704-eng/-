import { useEffect, useRef, useState } from 'react';
import type { TfdaLabelIndexEntry } from '../../shared/tfda-label-index';
import type { OfficialPackageLibrary } from '../../shared/official-packages';
import { requestJson } from '../services/http';
import PackageReferenceImages from './PackageReferenceImages';

export default function OfficialPackageImages({ entry, onChange }: { entry: TfdaLabelIndexEntry; onChange?: () => void }) {
  const [library, setLibrary] = useState<OfficialPackageLibrary>({ photos: [] });
  const [busy, setBusy] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const controller = useRef<AbortController | null>(null);
  const initialRead = useRef<AbortController | null>(null);
  useEffect(() => {
    const read = new AbortController(); initialRead.current = read; setLibrary({ photos: [] }); setError(''); setNotice('');
    requestJson<OfficialPackageLibrary>(`/api/medications/packages/official-references?${new URLSearchParams({ drugId: entry.licenseId })}`, { signal: read.signal })
      .then(setLibrary).catch(e => { if (!read.signal.aborted) setError((e as Error).message); });
    return () => { read.abort(); controller.current?.abort(); };
  }, [entry.licenseId]);
  async function save(sourceUrl: string) {
    if (controller.current) return;
    initialRead.current?.abort();
    const active = new AbortController(); controller.current = active; setBusy(sourceUrl); setError(''); setNotice('');
    try {
      const result = await requestJson<{ library: OfficialPackageLibrary; reused: boolean }>('/api/medications/packages/official-references', {
        method: 'POST', signal: active.signal, headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ drugId: entry.licenseId, sourceUrl, indexSha256: entry.sha256 }),
      });
      if (active.signal.aborted) return;
      setLibrary(result.library); setNotice('已保存到本機。請逐頁放大核對，確認後才加入藥盒照片比對。'); onChange?.();
    } catch (e) { if (!active.signal.aborted) setError((e as Error).message); }
    finally { if (controller.current === active) { controller.current = null; setBusy(''); } }
  }
  async function setEnabled(key: string, enabled: boolean) {
    if (controller.current) return;
    initialRead.current?.abort();
    const active = new AbortController(); controller.current = active; setBusy(key); setError(''); setNotice('');
    try {
      await requestJson(`/api/medications/packages/official-references/${key}/${enabled ? 'enable' : 'disable'}`, {
        method: 'POST', signal: active.signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirmed: enabled }),
      });
      if (active.signal.aborted) return;
      setLibrary(previous => ({ ...previous, photos: previous.photos.map(photo => photo.key === key ? { ...photo, usable: enabled, disabled: !enabled, pending: false, reason: enabled ? undefined : '已停用比對' } : photo) }));
      setNotice(enabled ? '這頁已加入本機藥盒比對。' : '已停用這頁，後續不再參與藥盒比對；仍可查看。'); onChange?.();
    } catch (e) { if (!active.signal.aborted) setError((e as Error).message); }
    finally { if (controller.current === active) { controller.current = null; setBusy(''); } }
  }
  return <div className="mt-3 space-y-3">
    <p className="text-xs leading-relaxed text-slate-600">首次保存需連線，PDF 會逐頁轉圖。保存後可離線查看，逐頁核對後才能加入照片比對。官方檔案也可能有舊版或規格不一致的頁面；若品名、劑量或許可證有疑義，請勿加入比對。</p>
    {error && <p role="alert" className="text-xs text-red-800">{error}</p>}
    {library.warning && <p role="alert" className="text-xs text-amber-900">{library.warning}</p>}
    {notice && <p role="status" className="text-xs text-emerald-800">{notice}</p>}
    {busy && <div className="text-xs text-slate-600"><span role="status">正在處理官方外盒資料…</span> <button type="button" onClick={() => { controller.current?.abort(); setNotice('已停止等待；再次按保存可確認是否已完成，重試不會重複建立。'); }} className="underline">停止等待</button></div>}
    <div className="max-h-[34rem] overflow-y-auto space-y-3 pr-1">{entry.packageUrls.map((sourceUrl, i) => {
      const photos = library.photos.filter(photo => photo.sourceUrl === sourceUrl), usable = photos.filter(photo => photo.usable && photo.imageUrl);
      const complete = photos.length > 0 && photos.every(photo => photo.imageUrl && photo.pageCount === photos.length);
      return <div key={sourceUrl} className="rounded-xl border border-slate-200 bg-white p-3">
        <div className="flex flex-wrap items-center gap-3 text-xs">
          <a href={sourceUrl} target="_blank" rel="noreferrer" className="text-emerald-800 underline">外盒來源 {i + 1}（需連線）</a>
          {!complete && <button type="button" disabled={!!busy} onClick={() => void save(sourceUrl)} className="min-h-10 rounded-lg bg-emerald-700 px-3 py-2 text-white disabled:opacity-50">{photos.length ? '重新保存外盒' : '保存外盒並預覽'}</button>}
          {complete && <span className="text-emerald-800">已存 {photos.length} 頁，可離線查看；{usable.length} 頁已加入比對</span>}
        </div>
        {photos.map(photo => <div key={photo.key} className="mt-2">
          {photo.imageUrl && <PackageReferenceImages name={`${entry.name}（第 ${photo.page} 頁）`} images={[{ url: photo.imageUrl, sourceUrl,
            sourceNote: `TFDA 外盒／標籤來源第 ${photo.page}/${photo.pageCount} 頁，取得 ${photo.retrievedAt.slice(0, 10)}；依許可證 ${entry.licenseId} 連結。` }]} />
          }
          {photo.reason && <p className="text-xs text-amber-900">第 {photo.page} 頁：{photo.reason}</p>}
          {photo.imageUrl && <button type="button" disabled={!!busy} onClick={() => void setEnabled(photo.key, !photo.usable)} className="mt-2 min-h-10 rounded-lg border border-slate-300 px-3 py-2 text-xs text-slate-700 disabled:opacity-50">{photo.usable ? `停用第 ${photo.page} 頁比對` : `已核對第 ${photo.page} 頁，加入比對`}</button>}
        </div>)}
      </div>;
    })}</div>
  </div>;
}
