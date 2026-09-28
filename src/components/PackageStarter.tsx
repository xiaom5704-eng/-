import { useEffect, useState } from 'react';
import type { PackageStarterItem, PackageStarterResult } from '../../shared/package-starter';
import { requestJson } from '../services/http';

export default function PackageStarter({ disabled, onPrepare }: { disabled: boolean; onPrepare: () => Promise<PackageStarterResult[]> }) {
  const [items, setItems] = useState<PackageStarterItem[]>([]);
  const [error, setError] = useState('');
  const [results, setResults] = useState<PackageStarterResult[]>([]);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    const controller = new AbortController(); setError('');
    void requestJson<{ items: PackageStarterItem[] }>('/api/medications/packages/starter-references', { signal: controller.signal })
      .then(data => { if (!controller.signal.aborted) setItems(data.items); })
      .catch(e => { if (!controller.signal.aborted) setError(e.message); });
    return () => controller.abort();
  }, [reload]);
  async function prepare() {
    setError(''); setResults([]);
    try { setResults(await onPrepare()); }
    catch (e) { setError((e as Error).message); }
  }
  return <section aria-label="示範藥盒圖庫" className="mt-3 rounded-xl border border-slate-200 p-3 text-sm">
    <p className="font-medium text-slate-800">先準備可比對的示範外盒</p>
    <p className="mt-1 text-xs leading-relaxed text-slate-600">首次從食藥署下載下列已核對版本，之後在本機比對，不需要金鑰。只涵蓋列出的品項；照片候選仍需核對實物。</p>
    <ul className="mt-2 space-y-2 text-xs text-slate-600">{items.map(item => <li key={item.id}>
      <a className="text-emerald-800 underline" href={item.sourceUrl} target="_blank" rel="noreferrer">{item.name} · 官方來源</a>
      <p>{item.drugId} · {item.note}</p>
    </li>)}</ul>
    <button type="button" disabled={disabled || !items.length} onClick={() => void prepare()} className="mt-3 rounded-lg border border-emerald-700 px-3 py-2 text-emerald-800 disabled:opacity-50">下載示範外盒</button>
    {error && <p role="alert" className="mt-2 text-xs text-amber-900">{error}{!items.length && <button type="button" disabled={disabled} className="ml-2 underline" onClick={() => setReload(n => n + 1)}>重讀清單</button>}</p>}
    {!!results.length && <ul role="status" className="mt-2 space-y-1 text-xs">{results.map(result => <li key={result.item.id} className={result.outcome === 'failed' ? 'text-amber-900' : 'text-emerald-900'}>
      {result.item.name}：{result.outcome === 'failed' ? '未完成，' : ''}{result.message}
    </li>)}</ul>}
  </section>;
}
