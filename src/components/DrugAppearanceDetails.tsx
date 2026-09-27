import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ExternalLink, ImageOff, ZoomIn, X } from 'lucide-react';
import type { DrugAppearance } from '../../shared/medication';

type Props = { appearance: DrugAppearance; drugName: string; licenseId: string };
const display = (value: string) => value.replace(/;;;|；；；/g, '／');

function AppearanceText({ appearance }: { appearance: DrugAppearance }) {
  return <div className="space-y-1 leading-relaxed">
    <p>{[appearance.shape, appearance.color, appearance.score && `刻痕：${appearance.score}`].filter(Boolean).map(display).join(' · ') || '來源未提供顏色與形狀'}</p>
    <p>刻字：{[appearance.imprint1, appearance.imprint2].filter(Boolean).map(display).join('／') || '未提供'}{appearance.size && ` · 外觀尺寸原文：${display(appearance.size)}`}</p>
  </div>;
}

function AppearanceImage({ url, alt, enlarged = false, zoom = 1, onZoom }: { url: string; alt: string; enlarged?: boolean; zoom?: number; onZoom?: (zoom: number) => void }) {
  const [status, setStatus] = useState<'loading' | 'loaded' | 'failed'>('loading');
  const [aspect, setAspect] = useState(1);
  const viewport = useRef<HTMLDivElement>(null), focus = useRef({ x: 0.5, y: 0.5 });
  useEffect(() => setStatus('loading'), [url]);
  useLayoutEffect(() => {
    const element = viewport.current;
    if (!enlarged || status !== 'loaded' || !element) return;
    element.scrollLeft = zoom === 1 ? 0 : element.scrollWidth * focus.current.x - element.clientWidth / 2;
    element.scrollTop = zoom === 1 ? 0 : element.scrollHeight * focus.current.y - element.clientHeight / 2;
  }, [enlarged, zoom, aspect, status]);
  return <div ref={viewport} tabIndex={enlarged ? 0 : undefined} aria-label={enlarged ? '藥品圖片捲動區' : undefined} className={`relative bg-white ${enlarged ? 'min-h-48 max-h-[60dvh] overflow-auto' : 'flex items-center justify-center h-28 w-36'}`}>
    {status === 'loading' && <span role="status" className="absolute text-xs text-slate-500">圖片載入中…</span>}
    {status === 'failed' ? <span className="flex flex-col items-center gap-2 p-4 text-xs text-slate-500"><ImageOff size={24} aria-hidden="true" />圖片暫時無法載入</span> : <img src={url} alt={alt} loading={enlarged ? 'eager' : 'lazy'} decoding="async" referrerPolicy="no-referrer"
      onLoad={event => { setAspect(event.currentTarget.naturalWidth / event.currentTarget.naturalHeight); setStatus('loaded'); }} onError={() => setStatus('failed')}
      onDoubleClick={enlarged ? event => {
        const rect = event.currentTarget.getBoundingClientRect();
        focus.current = { x: (event.clientX - rect.left) / rect.width, y: (event.clientY - rect.top) / rect.height };
        onZoom?.(Math.min(4, zoom * 2));
      } : undefined}
      style={enlarged ? { width: `calc(min(100%, ${60 * aspect}dvh) * ${zoom})`, maxWidth: 'none' } : undefined}
      className={`${enlarged ? `block h-auto ${zoom === 1 ? 'mx-auto' : ''}` : 'h-full w-full object-contain p-1'} ${status === 'loaded' ? '' : 'invisible'}`} />}
  </div>;
}

function AppearanceDialog({ appearance, drugName, licenseId, urls, index, onChange, onClose }: Props & { urls: string[]; index: number; onChange: (index: number) => void; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [zoom, setZoom] = useState(1);
  const detailImage = appearance.localDetailImages?.[urls[index]];
  useEffect(() => setZoom(1), [index]);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  const close = () => { dialog.current?.close(); onClose(); };
  return createPortal(<dialog ref={dialog} aria-labelledby={titleId} onCancel={event => { event.preventDefault(); close(); }}
    onClick={event => { if (event.target === event.currentTarget) close(); }}
    className="m-auto max-h-[92dvh] w-[calc(100%-2rem)] max-w-3xl overflow-y-auto rounded-2xl border-0 bg-white p-0 text-slate-800 shadow-2xl backdrop:bg-slate-950/70">
    <div className="p-4 sm:p-6">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0"><h2 id={titleId} className="text-lg font-bold break-words">{drugName}</h2><p className="mt-1 text-xs text-slate-500 break-words">{licenseId} · 食藥署外觀圖 {index + 1} / {urls.length}</p></div>
        <button autoFocus type="button" onClick={close} aria-label="關閉藥品圖片" className="shrink-0 rounded-full p-2 text-slate-600 hover:bg-slate-100 focus-visible:outline-emerald-600"><X size={22} aria-hidden="true" /></button>
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-2 text-xs" aria-label="圖片放大倍率">
        {[1, 2, 4].map(value => <button key={value} type="button" aria-pressed={zoom === value} onClick={() => setZoom(value)} className={`rounded-lg border px-3 py-2 ${zoom === value ? 'border-emerald-700 bg-emerald-50 text-emerald-800' : 'border-slate-200'}`}>{value === 1 ? '看整張' : `放大 ${value} 倍`}</button>)}
        <span className="text-slate-500">{zoom > 1 ? '可左右、上下捲動查看細節' : '點兩下圖片，可放大該位置'}</span>
      </div>
      <div className="my-4 overflow-hidden rounded-xl border border-slate-200"><AppearanceImage key={urls[index]} url={detailImage?.url || appearance.localImageUrls?.[urls[index]] || urls[index]} alt={`${drugName}－食藥署外觀圖 ${index + 1}`} enlarged zoom={zoom} onZoom={setZoom} /></div>
      {detailImage && <p className="mb-3 text-xs text-slate-500">官方來源清晰圖已存本機 · {detailImage.width} × {detailImage.height} · 取得於 {new Date(detailImage.fetchedAt).toLocaleDateString('zh-TW')}</p>}
      {urls.length > 1 && <div className="mb-4 flex items-center justify-center gap-4 text-sm">
        <button type="button" disabled={index === 0} onClick={() => onChange(index - 1)} className="rounded-lg border px-3 py-2 disabled:opacity-40">上一張</button>
        <span>{index + 1} / {urls.length}</span>
        <button type="button" disabled={index === urls.length - 1} onClick={() => onChange(index + 1)} className="rounded-lg border px-3 py-2 disabled:opacity-40">下一張</button>
      </div>}
      <div className="rounded-xl bg-slate-50 p-3 text-sm"><AppearanceText appearance={appearance} /></div>
      <p className="mt-3 text-xs leading-relaxed text-slate-600">請一起核對藥名、規格及刻字；圖片顏色與顯示大小不能作為唯一判斷。</p>
      <a href={urls[index]} target="_blank" rel="noreferrer" className="mt-3 inline-flex items-center gap-1 text-sm text-emerald-800 underline">開啟食藥署原圖 <ExternalLink size={14} aria-hidden="true" /></a>
    </div>
  </dialog>, document.body);
}

export default function DrugAppearanceDetails({ appearance, drugName, licenseId }: Props) {
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const urls = [...new Set(appearance.imageUrls)];
  const localCount = urls.filter(url => appearance.localImageUrls?.[url]).length;
  return <div className="rounded-xl bg-slate-50 p-3 text-xs text-slate-600 space-y-2 mt-3">
    <p className="font-semibold text-slate-800">本機外觀紀錄</p>
    <AppearanceText appearance={appearance} />
    {urls.length ? <>
      <p className="text-slate-500">食藥署參考圖片 · 點圖放大{localCount === urls.length ? '（已存本機）' : localCount ? `（${localCount}/${urls.length} 張已存本機，其餘需連線）` : '（需連線）'}</p>
      <div className="flex flex-wrap gap-3">{urls.map((url, i) => <button key={url} type="button" aria-label={`放大${drugName}的外觀圖 ${i + 1}`} onClick={() => setOpenIndex(i)}
        className="overflow-hidden rounded-xl border border-slate-200 bg-white text-left hover:border-emerald-600 focus-visible:outline-emerald-600">
        <AppearanceImage url={appearance.localImageUrls?.[url] || url} alt={`${drugName}－食藥署外觀圖 ${i + 1}`} />
        <span className="flex items-center justify-between gap-2 border-t border-slate-100 px-3 py-2 text-emerald-800">外觀圖 {i + 1}<ZoomIn size={15} aria-hidden="true" /></span>
      </button>)}</div>
    </> : <p className="text-slate-500">此筆外觀資料未提供圖片，請核對上方文字及原包裝。</p>}
    {openIndex !== null && urls[openIndex] && <AppearanceDialog appearance={appearance} drugName={drugName} licenseId={licenseId} urls={urls} index={openIndex} onChange={setOpenIndex} onClose={() => setOpenIndex(null)} />}
  </div>;
}
