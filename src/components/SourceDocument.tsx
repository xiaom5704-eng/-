import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { PDFDocumentLoadingTask, PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
import { X } from 'lucide-react';
import { isLocalDocumentPath, validLocalDocument, type SavedSourceDocument } from '../../shared/source-document';

function DocumentDialog({ saved, title, sourceUrl, onClose }: { saved: SavedSourceDocument; title: string; sourceUrl: string; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null), canvas = useRef<HTMLCanvasElement>(null);
  const titleId = useId();
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [page, setPage] = useState(1), [zoom, setZoom] = useState(1);
  const [loading, setLoading] = useState(true), [error, setError] = useState('');
  useEffect(() => {
    const element = dialog.current; element?.showModal();
    return () => element?.close();
  }, []);
  useEffect(() => {
    let cancelled = false, task: PDFDocumentLoadingTask | undefined;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20_000);
    void (async () => {
      try {
        const response = await fetch(saved.url, { signal: controller.signal });
        if (!response.ok) throw Error('本機副本無法讀取，請重新分析或核對原始來源。');
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.length !== saved.byteLength || bytes.length > 5_000_000) throw Error('本機副本長度不符，未顯示文件。');
        if (cancelled) return;
        const pdfjs = await import('pdfjs-dist');
        const { default: workerUrl } = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
        if (cancelled) return;
        pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
        const base = `${import.meta.env.BASE_URL}ocr/`;
        task = pdfjs.getDocument({ data: bytes, isEvalSupported: false, cMapUrl: `${base}cmaps/`, cMapPacked: true,
          standardFontDataUrl: `${base}standard_fonts/`, wasmUrl: `${base}wasm/` });
        const document = await task.promise;
        if (document.numPages < 1 || document.numPages > 50) throw Error('此文件頁數超出目前閱讀範圍，請開啟 PDF 副本核對。');
        if (!cancelled) setPdf(document);
      } catch (failure) {
        if (!cancelled) { setError(failure instanceof Error && failure.name !== 'AbortError' ? failure.message : '本機副本讀取逾時，請關閉後重試。'); setLoading(false); }
      } finally { clearTimeout(timeout); }
    })();
    return () => { cancelled = true; clearTimeout(timeout); controller.abort(); void task?.destroy(); };
  }, [saved.url, saved.byteLength]);
  useEffect(() => {
    if (!pdf || !canvas.current) return;
    let cancelled = false, rendering: RenderTask | undefined;
    const target = canvas.current;
    // Each render owns a detached canvas. A cancelled older page cannot paint
    // over the currently selected page or race a second render on the same canvas.
    const buffer = window.document.createElement('canvas');
    setLoading(true); setError('');
    void (async () => {
      try {
        const sourcePage = await pdf.getPage(page);
        if (cancelled) return;
        const original = sourcePage.getViewport({ scale: 1 });
        const cssWidth = Math.min(850, Math.max(240, (target.parentElement?.clientWidth || 600) - 16)) * zoom;
        const scale = Math.min(cssWidth / original.width * Math.min(window.devicePixelRatio || 1, 2), Math.sqrt(8_000_000 / (original.width * original.height)));
        const viewport = sourcePage.getViewport({ scale });
        buffer.width = Math.ceil(viewport.width); buffer.height = Math.ceil(viewport.height);
        rendering = sourcePage.render({ canvas: buffer, canvasContext: buffer.getContext('2d')!, viewport });
        await rendering.promise;
        if (cancelled) return;
        target.width = buffer.width; target.height = buffer.height;
        target.style.width = `${cssWidth}px`; target.style.height = 'auto';
        target.getContext('2d')!.drawImage(buffer, 0, 0);
        target.parentElement?.scrollTo({ left: 0, top: 0 }); setLoading(false);
      } catch { if (!cancelled) { setError('這一頁無法顯示，請重試或開啟完整 PDF 副本。'); setLoading(false); } }
      finally { buffer.width = 0; buffer.height = 0; }
    })();
    return () => { cancelled = true; rendering?.cancel(); };
  }, [pdf, page, zoom]);
  return createPortal(<dialog ref={dialog} aria-labelledby={titleId} onCancel={event => { event.preventDefault(); onClose(); }}
    className="m-auto max-h-[94dvh] w-[calc(100%-1rem)] max-w-5xl overflow-y-auto rounded-2xl bg-white p-4 sm:p-6 text-slate-800 shadow-xl backdrop:bg-slate-950/70">
    <div className="flex items-start justify-between gap-3"><div><h2 id={titleId} className="font-bold text-lg">{title}</h2><p className="text-xs leading-relaxed mt-2">已存本機 · 取得 {saved.retrievedAt}<br />保留來源版本，不保證為最新版；請核對適用產品。</p></div><button type="button" autoFocus aria-label="關閉仿單閱讀" onClick={onClose} className="p-2 rounded-full hover:bg-slate-100"><X size={22} /></button></div>
    <div className="my-4 flex flex-wrap items-center gap-2 text-sm">
      <button type="button" disabled={!pdf || page <= 1} onClick={() => setPage(value => value - 1)} className="rounded-lg border px-3 py-2 disabled:opacity-40">上一頁</button>
      <span aria-live="polite">第 {page} / {pdf?.numPages || '…'} 頁</span>
      <button type="button" disabled={!pdf || page >= pdf.numPages} onClick={() => setPage(value => value + 1)} className="rounded-lg border px-3 py-2 disabled:opacity-40">下一頁</button>
      {[1, 2].map(value => <button type="button" key={value} aria-pressed={zoom === value} onClick={() => setZoom(value)} className={`rounded-lg border px-3 py-2 ${zoom === value ? 'border-emerald-700 bg-emerald-50 text-emerald-800' : 'border-slate-200'}`}>{value === 1 ? '適合寬度' : '放大 2 倍'}</button>)}
    </div>
    {loading && <p role="status" className="text-sm my-3">正在讀取本機 PDF…</p>}
    {error && <p role="alert" className="text-sm text-red-800 my-3">{error}</p>}
    <div className="max-h-[65dvh] overflow-auto rounded-lg border bg-slate-50 p-2" tabIndex={0} aria-label="仿單頁面捲動區"><canvas ref={canvas} role="img" aria-label={`${title}，第 ${page} 頁`} className={loading || error ? 'hidden' : 'block mx-auto max-w-none'} /></div>
    <div className="mt-4 flex flex-wrap gap-4 text-xs text-emerald-800 underline"><a href={saved.url} download={`source-${saved.sha256}.pdf`}>下載 PDF 副本</a><a href={sourceUrl} target="_blank" rel="noreferrer">核對原始網站（需連線）</a></div>
  </dialog>, document.body);
}

// Saved Markdown retains a stable local URL. Resolve its exact metadata on
// demand and use the same reader; embedded browsers may lack a native PDF tab.
export function SourceDocumentLink({ href, children }: { href: string; children: ReactNode }) {
  const [document, setDocument] = useState<(SavedSourceDocument & { title: string; sourceUrl: string }) | null>(null);
  const [loading, setLoading] = useState(false), [error, setError] = useState('');
  const revision = useRef(0), pending = useRef<AbortController | null>(null);
  useEffect(() => {
    revision.current++; setDocument(null); setError(''); setLoading(false);
    return () => { revision.current++; pending.current?.abort(); pending.current = null; };
  }, [href]);
  async function open() {
    if (!isLocalDocumentPath(href) || pending.current) return;
    const controller = new AbortController(); pending.current = controller;
    const requestRevision = revision.current;
    const timeout = setTimeout(() => controller.abort(), 10_000);
    setLoading(true); setError('');
    try {
      const response = await fetch(`${href.slice(0, -4)}.json`, { signal: controller.signal });
      if (!response.ok) throw Error('Unavailable document');
      const result = await response.json();
      if (!validLocalDocument(result) || result.url !== href || typeof result.title !== 'string' || typeof result.sourceUrl !== 'string') throw Error('Invalid document');
      if (revision.current === requestRevision) setDocument(result);
    } catch { if (revision.current === requestRevision) setError('此版本的本機副本無法開啟，請重新分析或核對報告中的原始來源。'); }
    finally { clearTimeout(timeout); if (pending.current === controller) pending.current = null; if (revision.current === requestRevision) setLoading(false); }
  }
  return <span><button type="button" disabled={loading} onClick={() => void open()} className="text-emerald-800 underline underline-offset-4 disabled:opacity-50">{loading ? '正在開啟本機文件…' : children}</button>
    {error && <span role="alert" className="ml-2 text-sm text-red-800">{error}</span>}
    {document && <DocumentDialog key={document.sha256} saved={document} title={document.title} sourceUrl={document.sourceUrl} onClose={() => setDocument(null)} />}
  </span>;
}

export default function SourceDocument({ saved, title, sourceUrl }: { saved?: SavedSourceDocument; title: string; sourceUrl: string }) {
  const [open, setOpen] = useState(false);
  if (!saved || !validLocalDocument(saved)) return null;
  return <div className="mt-2"><button type="button" onClick={() => setOpen(true)} className="text-sm font-semibold text-emerald-800 underline underline-offset-4">閱讀本機 PDF（不用連外）</button><p className="mt-1 text-xs leading-relaxed">副本取得：{saved.retrievedAt} · 非最新版保證</p>
    {open && <DocumentDialog key={saved.sha256} saved={saved} title={title} sourceUrl={sourceUrl} onClose={() => setOpen(false)} />}
  </div>;
}
