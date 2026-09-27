import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { VisionCandidate } from '../../shared/medication-vision';

function Enlarged({ url, name, onClose }: { url: string; name: string; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialog.current?.showModal(); return () => dialog.current?.close(); }, []);
  return createPortal(<dialog ref={dialog} aria-label={`${name}的藥盒參考圖`} onCancel={event => { event.preventDefault(); onClose(); }} className="m-auto max-h-[92dvh] w-[calc(100%-2rem)] max-w-3xl overflow-y-auto rounded-2xl bg-white p-5 text-slate-800 backdrop:bg-slate-950/70">
    <div className="flex items-start justify-between gap-3"><h3 className="font-bold">{name} · 本機藥盒參考圖</h3><button autoFocus type="button" onClick={onClose} className="rounded-lg border px-3 py-1">關閉圖片</button></div>
    <img src={url} alt={`${name}的藥盒參考圖`} className="my-4 max-h-[65dvh] w-full object-contain" />
    <p className="text-xs text-slate-600">參考圖依收錄時的品名連結候選，未確認許可證；請核對您的實際包裝。</p>
  </dialog>, document.body);
}

export default function PackageReferenceImages({ images, name }: { images: VisionCandidate['images']; name: string }) {
  const [url, setUrl] = useState<string | null>(null);
  return <div className="mt-3 space-y-2">
    <p className="text-xs font-medium text-slate-700">相似藥盒參考圖 · 已存本機</p>
    {images.map((image, i) => <div key={image.url}>
      <button type="button" aria-label={`放大${name}的藥盒參考圖 ${i + 1}`} onClick={() => setUrl(image.url)} className="block w-full overflow-hidden rounded-xl border border-slate-200 bg-white hover:border-emerald-600">
        <img src={image.url} alt={`${name}的藥盒參考圖 ${i + 1}`} className="h-36 w-full object-contain p-2" /><span className="block border-t p-2 text-xs text-emerald-800">點圖放大對照</span>
      </button>
      <p className="mt-1 text-xs leading-relaxed text-slate-500">來源：{image.sourceNote || '本機收錄照片'}</p>
    </div>)}
    {url && <Enlarged url={url} name={name} onClose={() => setUrl(null)} />}
  </div>;
}
