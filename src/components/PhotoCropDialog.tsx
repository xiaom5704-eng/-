import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export default function PhotoCropDialog({ data, onApply, onClose }: { data: string; onApply: (data: string) => void; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const image = useRef<HTMLImageElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const [crop, setCrop] = useState({ x: 0, y: 0, width: 100, height: 100 });
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { dialog.current?.showModal(); return () => dialog.current?.close(); }, []);
  const close = () => { dialog.current?.close(); onClose(); };
  const position = (event: React.PointerEvent) => {
    const rect = stage.current!.getBoundingClientRect();
    return { x: Math.max(0, Math.min(100, (event.clientX - rect.left) / rect.width * 100)), y: Math.max(0, Math.min(100, (event.clientY - rect.top) / rect.height * 100)) };
  };
  function apply() {
    if (!image.current || crop.width < 3 || crop.height < 3) { setError('選取範圍太小，請重新框選。'); return; }
    const source = image.current;
    const width = source.naturalWidth * crop.width / 100, height = source.naturalHeight * crop.height / 100;
    const scale = Math.min(1, 1800 / Math.max(width, height));
    const canvas = document.createElement('canvas'); canvas.width = Math.round(width * scale); canvas.height = Math.round(height * scale);
    const context = canvas.getContext('2d');
    if (!context) { setError('無法處理圖片，請改用原始照片。'); return; }
    context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(source, source.naturalWidth * crop.x / 100, source.naturalHeight * crop.y / 100, width, height, 0, 0, canvas.width, canvas.height);
    try { onApply(canvas.toDataURL('image/jpeg', 0.94)); close(); }
    catch (e) { setError(e instanceof Error ? e.message : '無法套用裁切，請重試。'); }
  }
  return createPortal(<dialog ref={dialog} onCancel={event => { event.preventDefault(); close(); }} aria-labelledby="photo-crop-title" className="m-auto max-h-[94dvh] w-[calc(100%-2rem)] max-w-2xl overflow-y-auto rounded-2xl bg-white p-5 text-slate-800 backdrop:bg-slate-950/70">
    <h3 id="photo-crop-title" className="font-bold text-lg">框選藥品或文字區域</h3>
    <p className="mt-2 text-sm text-slate-600">拖曳選取要辨識的範圍。藥錠請保留完整輪廓與刻字；藥盒、藥袋請保留完整藥名與規格。也可展開數值調整。</p>
    <p className="mt-1 text-xs text-slate-500">套用後可在照片下方還原原圖。裁切或還原會清除舊辨識結果與刻字，請重新核對。</p>
    <div className="mt-4 text-center"><div ref={stage} className="relative inline-block max-w-full touch-none select-none align-top cursor-crosshair"
      onPointerDown={event => { if (!ready) return; event.currentTarget.setPointerCapture(event.pointerId); start.current = position(event); }}
      onPointerMove={event => { if (!start.current) return; const end = position(event); setCrop({ x: Math.min(start.current.x, end.x), y: Math.min(start.current.y, end.y), width: Math.abs(end.x - start.current.x), height: Math.abs(end.y - start.current.y) }); }}
      onPointerUp={() => { start.current = null; }} onPointerCancel={() => { start.current = null; }}>
      <img ref={image} src={data} alt="待裁切的藥物照片" draggable={false} onLoad={() => setReady(true)} onError={() => setError('照片無法載入。')} className="block max-h-[45dvh] max-w-full object-contain" />
      <div className="pointer-events-none absolute border-2 border-emerald-500 bg-emerald-400/10" style={{ left: `${crop.x}%`, top: `${crop.y}%`, width: `${crop.width}%`, height: `${crop.height}%` }} />
    </div></div>
    <details className="mt-3 text-sm"><summary className="cursor-pointer">數值調整裁切範圍</summary>{(['x', 'y', 'width', 'height'] as const).map((key, index) => <label key={key} className="mt-2 flex items-center gap-3">{['左側', '上側', '寬度', '高度'][index]}<input type="range" min={key === 'x' || key === 'y' ? 0 : 3} max={key === 'x' ? 100 - crop.width : key === 'y' ? 100 - crop.height : key === 'width' ? 100 - crop.x : 100 - crop.y} value={crop[key]} onChange={event => setCrop(previous => ({ ...previous, [key]: Number(event.target.value) }))} /><span>{Math.round(crop[key])}%</span></label>)}</details>
    {error && <p role="alert" className="mt-2 text-sm text-red-700">{error}</p>}
    <div className="mt-4 flex flex-wrap gap-2"><button type="button" autoFocus onClick={close} className="rounded-lg border px-4 py-2 text-sm">取消</button><button type="button" onClick={() => setCrop({ x: 0, y: 0, width: 100, height: 100 })} className="rounded-lg border px-4 py-2 text-sm">重設範圍</button><button type="button" disabled={!ready} onClick={apply} className="rounded-lg bg-emerald-700 px-4 py-2 text-sm text-white disabled:opacity-50">套用裁切</button></div>
  </dialog>, document.body);
}
