import { ExternalLink } from 'lucide-react';
import type { TfdaLabelIndexEntry } from '../../shared/tfda-label-index';

export default function TaiwanLabelLinks({ entry }: { entry: TfdaLabelIndexEntry }) {
  return <div className="rounded-xl border border-emerald-100 bg-emerald-50/50 p-4 space-y-3">
    <h6 className="font-semibold text-sm text-slate-800">臺灣官方仿單與外盒</h6>
    <p className="text-xs text-slate-600 leading-relaxed">已從本機索引找到相同許可證及中英文品名。下列連結需連線開啟；尚未保存文件全文。</p>
    <div className="flex flex-col items-start gap-2">{entry.labelUrls.map((url, i) => <a key={url} href={url} target="_blank" rel="noreferrer"
      className="inline-flex items-center gap-2 min-h-11 rounded-lg border border-emerald-200 bg-white px-3 py-2 text-sm font-semibold text-emerald-800 underline underline-offset-4">
      查看官方仿單{entry.labelUrls.length > 1 ? ` ${i + 1}` : ''}（需連線）<ExternalLink size={14} className="shrink-0" aria-hidden="true" />
    </a>)}</div>
    {!entry.labelUrls.length && <p className="text-sm text-slate-600">這筆索引尚無可用的仿單入口。</p>}
    {entry.unavailableLabelLinks > 0 && <p className="text-xs text-amber-900 leading-relaxed">原始資料中的部分仿單連結不完整，已略過；請查看藥盒內的說明書或詢問藥師。</p>}
    {entry.labelUrls.some(url => url.includes('/exportpdf/')) && <p className="text-xs text-slate-600 leading-relaxed">此入口可能先開啟食藥署品項頁，請在該頁查看電子仿單或紙本檔案。</p>}
    {!!entry.packageUrls.length && <details className="text-sm text-slate-700">
      <summary className="cursor-pointer py-1">核對外盒圖片（{entry.packageUrls.length} 張，需連線）</summary>
      <div className="mt-2 flex flex-wrap gap-2 max-h-52 overflow-y-auto">{entry.packageUrls.map((url, i) => <a key={url} href={url} target="_blank" rel="noreferrer"
        className="inline-flex min-h-10 items-center gap-1 rounded-lg bg-white border border-slate-200 px-3 py-2 text-xs text-emerald-800 underline">外盒圖 {i + 1}<ExternalLink size={12} aria-hidden="true" /></a>)}</div>
    </details>}
    <p className="text-xs text-slate-500 leading-relaxed">索引取得：{entry.retrievedAt.slice(0, 10)}，不是仿單修訂日期。開啟後請核對許可證、規格與版本。<a href={entry.sourceUrl} target="_blank" rel="noreferrer" className="ml-1 text-emerald-800 underline">資料來源</a></p>
  </div>;
}
