import { useEffect, useRef, useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { isDirectTfdaPdf, type LabelSavedHandler, type TfdaLabelDocument, type TfdaLabelIndexEntry } from '../../shared/tfda-label-index';
import { validLocalDocument } from '../../shared/source-document';
import { requestJson } from '../services/http';
import OfficialPackageImages from './OfficialPackageImages';
import SourceDocument from './SourceDocument';

function OfficialLabel({ entry, url, number, onSaved }: { entry: TfdaLabelIndexEntry; url: string; number: number; onSaved?: LabelSavedHandler }) {
  const saved = entry.documents?.find(item => item.sourceUrl === url && validLocalDocument(item));
  const [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => { pending.current?.abort(); pending.current = null; }, []);
  async function save() {
    if (pending.current) return;
    const controller = new AbortController(); pending.current = controller; setBusy(true); setMessage('');
    const timeout = setTimeout(() => controller.abort(), 40_000);
    try {
      const document = await requestJson<TfdaLabelDocument>('/api/medications/tfda-documents', { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
        body: JSON.stringify({ licenseId: entry.licenseId, sourceUrl: url, indexSha256: entry.sha256, refresh: !!saved }) });
      if (!validLocalDocument(document) || document.sourceUrl !== url) throw Error('副本資料不完整，請重新分析後重試。');
      if (pending.current === controller) {
        onSaved?.(entry, document);
        setMessage(document.sha256 === saved?.sha256 ? '官方回傳的內容與原副本相同，保留原取得日期。' : '已保存，可在本頁閱讀，也可儲存到報告中。');
      }
    } catch (error) {
      if (pending.current === controller) setMessage(controller.signal.aborted ? '已停止等待。已完成保存的文件可重新分析後查看，原副本仍保留。' : (error as Error).message);
    } finally { clearTimeout(timeout); if (pending.current === controller) { pending.current = null; setBusy(false); } }
  }
  return <div className="w-full rounded-lg border border-emerald-200 bg-white p-3 space-y-2">
    <a href={url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 min-h-11 text-sm font-semibold text-emerald-800 underline underline-offset-4">
      查看官方仿單{entry.labelUrls.length > 1 ? ` ${number}` : ''}（需連線）<ExternalLink size={14} className="shrink-0" aria-hidden="true" />
    </a>
    {isDirectTfdaPdf(url, entry.licenseId) && onSaved && <div className="flex flex-wrap items-center gap-3">
      <button type="button" disabled={busy} onClick={() => void save()} className="min-h-11 rounded-lg border border-emerald-300 px-3 py-2 text-sm font-semibold text-emerald-800 disabled:opacity-50">{busy ? '正在保存官方 PDF…' : saved ? '重新下載官方版本（需連線）' : '保存官方仿單到本機'}</button>
      {busy && <button type="button" onClick={() => pending.current?.abort()} className="min-h-11 text-sm underline">取消下載</button>}
    </div>}
    {message && <p role="status" className="text-sm leading-relaxed text-slate-700">{message}</p>}
    <SourceDocument saved={saved} title={`${entry.name} · 官方仿單副本（${entry.licenseId}）`} sourceUrl={url} />
  </div>;
}

export default function TaiwanLabelLinks({ entry, onPackageChange, onLabelSaved }: { entry: TfdaLabelIndexEntry; onPackageChange?: () => void; onLabelSaved?: LabelSavedHandler }) {
  return <div className="rounded-xl border border-emerald-100 bg-emerald-50/50 p-4 space-y-3">
    <h6 className="font-semibold text-sm text-slate-800">臺灣官方仿單與外盒</h6>
    <p className="text-xs text-slate-600 leading-relaxed">已從本機索引找到相同許可證及中英文品名。首次保存需連線，之後可離線閱讀副本；尚未人工核對文件內容及修訂版本，請確認文件上的品名、規格與許可證。</p>
    <div className="flex flex-col items-start gap-2">{entry.labelUrls.map((url, i) => <OfficialLabel key={`${entry.licenseId}:${entry.sha256}:${url}`} entry={entry} url={url} number={i + 1} onSaved={onLabelSaved} />)}</div>
    {!entry.labelUrls.length && <p className="text-sm text-slate-600">這筆索引尚無可用的仿單入口。</p>}
    {entry.unavailableLabelLinks > 0 && <p className="text-xs text-amber-900 leading-relaxed">原始資料中的部分仿單連結不完整，已略過；請查看藥盒內的說明書或詢問藥師。</p>}
    {entry.labelUrls.some(url => url.includes('/exportpdf/')) && <p className="text-xs text-slate-600 leading-relaxed">此入口可能先開啟食藥署品項頁，請在該頁查看電子仿單或紙本檔案。</p>}
    {!!entry.packageUrls.length && <details className="text-sm text-slate-700">
      <summary className="cursor-pointer py-1">查看與保存外盒（{entry.packageUrls.length} 份來源）</summary>
      <OfficialPackageImages entry={entry} onChange={onPackageChange} />
    </details>}
    <p className="text-xs text-slate-500 leading-relaxed">索引取得：{entry.retrievedAt.slice(0, 10)}，不是仿單修訂日期。開啟後請核對許可證、規格與版本。<a href={entry.sourceUrl} target="_blank" rel="noreferrer" className="ml-1 text-emerald-800 underline">資料來源</a></p>
  </div>;
}
