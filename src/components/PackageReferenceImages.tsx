import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { VisionCandidate } from '../../shared/medication-vision';

function Enlarged({ url, name, kind, onClose }: { url: string; name: string; kind: 'pill' | 'package'; onClose: () => void }) {
  const label = kind === 'pill' ? '自存藥錠照片' : '藥盒參考圖';
  const [zoom, setZoom] = useState(1);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialog.current?.showModal(); return () => dialog.current?.close(); }, []);
  return createPortal(<dialog ref={dialog} aria-label={`${name}的${label}`} onCancel={event => { event.preventDefault(); onClose(); }} className="m-auto max-h-[92dvh] w-[calc(100%-2rem)] max-w-3xl overflow-y-auto rounded-2xl bg-white p-5 text-slate-800 backdrop:bg-slate-950/70">
    <div className="flex items-start justify-between gap-3"><h3 className="font-bold">{name} · {label}</h3><button autoFocus type="button" onClick={onClose} className="shrink-0 whitespace-nowrap rounded-lg border px-3 py-1">關閉圖片</button></div>
    <div className="my-3 flex flex-wrap items-center gap-2 text-xs" aria-label="圖片縮放">
      {[1, 2, 4].map(scale => <button key={scale} type="button" aria-pressed={zoom === scale} onClick={() => setZoom(scale)} className={`min-h-10 rounded-lg border px-3 py-2 ${zoom === scale ? 'border-emerald-700 bg-emerald-50 text-emerald-900' : 'border-slate-300'}`}>{scale === 1 ? '整張圖片' : `放大 ${scale} 倍`}</button>)}
      {zoom > 1 && <span>可上下左右捲動查看細節</span>}
    </div>
    <div className="my-4 max-h-[65dvh] overflow-auto rounded-lg border border-slate-100" tabIndex={0} aria-label="圖片細節，可捲動查看">
      <img src={url} alt={`${name}的${label}`} className={zoom === 1 ? 'max-h-[65dvh] w-full object-contain' : 'max-w-none'} style={zoom > 1 ? { width: `${zoom * 100}%` } : undefined} />
    </div>
    <p className="text-xs text-slate-600">{kind === 'pill' ? '使用者核對後收錄的照片，非官方參考圖；相似外觀仍不能確認您的藥品。' : '請依圖片來源、品名、規格及許可證核對實際包裝；照片相似不代表已確認您的藥品。'}</p>
  </dialog>, document.body);
}

export default function PackageReferenceImages({ images, name, kind = 'package' }: { images: VisionCandidate['images']; name: string; kind?: 'pill' | 'package' }) {
  const [url, setUrl] = useState<string | null>(null);
  const label = kind === 'pill' ? '自存藥錠照片' : '藥盒參考圖';
  return <div className="mt-3 space-y-2">
    <p className="text-xs font-medium text-slate-700">{kind === 'pill' ? '使用者核對的本機照片 · 非官方' : '藥盒參考圖 · 已存本機'}</p>
    {images.map((image, i) => <div key={image.url}>
      <button type="button" aria-label={`放大${name}的${label} ${i + 1}`} onClick={() => setUrl(image.url)} className="block w-full overflow-hidden rounded-xl border border-slate-200 bg-white hover:border-emerald-600">
        <img src={image.url} alt={`${name}的${label} ${i + 1}`} className="h-36 w-full object-contain p-2" /><span className="block border-t p-2 text-xs text-emerald-800">點圖放大對照</span>
      </button>
      <p className="mt-1 text-xs leading-relaxed text-slate-500">來源：{image.sourceNote || '本機收錄照片'}</p>
    </div>)}
    {url && <Enlarged url={url} name={name} kind={kind} onClose={() => setUrl(null)} />}
  </div>;
}
