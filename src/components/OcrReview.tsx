import { useRef, useState } from 'react';
import { combineOcrLines, ocrReviewLines, type OcrPage, type OcrTarget } from '../../shared/medication-ocr';
import OcrQuerySuggestion from './OcrQuerySuggestion';

export default function OcrReview({ pages, target, disabled, onChange, onSwitchReading, onSearch, onQueryEdit }: {
  pages: OcrPage[]; target: OcrTarget; disabled: boolean;
  onChange: (index: number, text: string) => void; onSearch: (line: string) => void;
  onSwitchReading: (index: number) => void;
  onQueryEdit: () => void;
}) {
  const label = target === 'pill' ? '刻字' : '藥名';
  return <div className="mt-4 space-y-4 rounded-xl border border-emerald-200 bg-emerald-50/30 p-4">
    <div><h4 className="text-sm font-semibold">本機讀取完成 — 請核對文字</h4>
      <p className="mt-1 text-xs leading-relaxed text-slate-600">可直接修改文字，再點選下方{label}查本機資料。{target === 'pill' ? '請先排除尺規與背景文字，同一面的刻字可勾選多行合併查詢。' : '每行是一個查詢，請刪除姓名、日期等非藥名文字。藥名分在多行時，可將同一品項的品牌與完整名稱合併查詢；請保留規格，不要合併不同藥品。'} OCR 可能讀錯中文字或混淆 0／O、1／I，請對照原圖核對。</p></div>
    {pages.map((page, index) => <OcrPageReview key={`${page.fileName}:${page.page}:${index}:${page.reading || 'native'}`} page={page} index={index} target={target}
      disabled={disabled} onChange={text => onChange(index, text)} onSwitchReading={() => onSwitchReading(index)} onSearch={onSearch} onQueryEdit={onQueryEdit} />)}
  </div>;
}

function OcrPageReview({ page, index, target, disabled, onChange, onSwitchReading, onSearch, onQueryEdit }: {
  page: OcrPage; index: number; target: OcrTarget; disabled: boolean;
  onChange: (text: string) => void; onSearch: (line: string) => void;
  onSwitchReading: () => void;
  onQueryEdit: () => void;
}) {
  const [selected, setSelected] = useState<number[]>([]);
  const [focused, setFocused] = useState<number | null>(null);
  const preview = useRef<HTMLElement>(null);
  const entries = ocrReviewLines(page, target), lines = entries.map(entry => entry.text), label = target === 'pill' ? '刻字' : '藥名';
  const hasPositions = entries.some(entry => entry.boxes.length);
  const selectedLines = lines.filter((_, i) => selected.includes(i));
  const maxQueryLength = target === 'pill' ? 80 : 120;
  let combined = '', combinationError = '';
  if (selectedLines.length >= 2) {
    try { combined = combineOcrLines(selectedLines, target, maxQueryLength); } catch (error) { combinationError = (error as Error).message; }
  }
  return <div className="space-y-2">
        {page.alternative && <div className="rounded-lg border border-emerald-200 bg-white p-3">
          <p className="text-xs leading-relaxed text-slate-600">已補讀小字，可切換兩組結果並對照照片。校正文字會保留；切換後請重新勾選要查詢的行。</p>
          <div aria-label={`${page.fileName} 的讀取結果`} className="mt-2 flex flex-wrap gap-2">
            {(['native', 'enlarged'] as const).map(reading => <button key={reading} type="button" disabled={disabled} aria-pressed={page.reading === reading}
              onClick={() => { if (page.reading !== reading) onSwitchReading(); }} className={`rounded-lg border px-3 py-2 text-sm ${page.reading === reading ? 'border-emerald-600 bg-emerald-50 text-emerald-800' : 'border-slate-200 bg-white text-slate-700'} disabled:opacity-50`}>
              {reading === 'native' ? '原尺寸結果' : '小字補讀結果'}</button>)}
          </div>
        </div>}
        {page.readNotice && <p role="status" className="text-xs text-amber-800">{page.readNotice}</p>}
        {page.layout && hasPositions && <figure ref={preview} aria-label={`${page.fileName} 的文字位置`} className="rounded-lg border border-slate-200 bg-white p-3">
          <figcaption className="mb-2 text-xs leading-relaxed text-slate-600">勾選文字看綠框，按「查看位置」看橙框。請核對讀字，排除尺規、背景及其他藥品。</figcaption>
          <div className="relative mx-auto w-fit max-w-full">
            <img src={page.layout.image} alt={`${page.fileName} 的 OCR 原圖對照`} className="block max-h-96 max-w-full" />
            <svg aria-hidden="true" viewBox="0 0 100 100" preserveAspectRatio="none" className="pointer-events-none absolute inset-0 h-full w-full">
              {entries.flatMap((entry, i) => entry.boxes.map((box, j) => <rect key={`${i}:${j}`} x={box.left} y={box.top} width={box.width} height={box.height}
                fill={focused === i ? '#f59e0b22' : selected.includes(i) ? '#10b98122' : 'none'}
                stroke={focused === i ? '#b45309' : selected.includes(i) ? '#047857' : '#64748b'} strokeWidth={focused === i || selected.includes(i) ? 3 : 1} vectorEffect="non-scaling-stroke" />))}
            </svg>
          </div>
          <p role="status" className="mt-2 text-xs text-slate-700">{focused !== null && entries[focused]?.boxes.length ? `橙框：第 ${focused + 1} 行「${lines[focused]}」` : '灰框是讀取位置；尚未確認是否為藥名或刻字。'}</p>
        </figure>}
        {page.layout && page.layout.text !== page.text && <p className="text-xs text-slate-600">文字已修改，原位置標示已停用；請對照上方附件照片核對。重新辨識可取得新的位置。</p>}
        <label className="block text-xs text-slate-600">{page.fileName} · 第 {page.page} 頁
          <textarea aria-label={`校正辨識文字 ${index + 1}`} disabled={disabled} value={page.text} maxLength={10000} rows={4} onChange={e => { setSelected([]); setFocused(null); onChange(e.target.value); }} className="mt-1 block w-full rounded-lg border border-slate-300 bg-white p-3 text-sm leading-relaxed" />
        </label>
        {page.confidence < 70 && <p className="text-xs text-amber-800">這頁文字辨識信心偏低，請特別核對字母、數字與小數點。</p>}
        {!lines.length && <p className="text-sm text-slate-600">沒有讀到清楚文字，可在上方手動填入，或補拍近照。</p>}
        {target === 'label' && lines.length > 1 && <p className="text-xs leading-relaxed text-slate-600">同一藥盒的品牌、品名分在多行？勾選 2–6 行一起查詢。不要合併不同藥品或姓名、日期；簡繁字形會一起搜尋，誤字仍須校正。</p>}
        {target === 'pill' && lines.length > 1 && <p className="text-xs leading-relaxed text-slate-600">同一面的刻字分成多行？對照照片後勾選 2–6 行合併。不要加入另一面的刻字、其他藥錠、尺規或背景文字；讀錯的數字請先校正。</p>}
        <div className="max-h-56 overflow-y-auto space-y-2">{lines.map((line, i) => <div key={i} className="flex items-start gap-2">
          {lines.length > 1 && <input type="checkbox" aria-label={`合併選取${target === 'pill' ? `第 ${i + 1} 行` : ''}：${line}`} checked={selected.includes(i)}
            disabled={disabled || (!selected.includes(i) && selectedLines.length >= 6)} className="mt-3 h-4 w-4 shrink-0 accent-emerald-700"
            onChange={e => setSelected(previous => e.target.checked ? [...previous, i] : previous.filter(value => value !== i))} />}
          {!!entries[i].boxes.length && <button type="button" disabled={disabled} aria-label={`查看第 ${i + 1} 行「${line}」的位置`} aria-pressed={focused === i}
            onClick={() => { setFocused(previous => previous === i ? null : i); if (focused !== i) preview.current?.scrollIntoView({ block: 'nearest' }); }} className="shrink-0 rounded-lg border border-slate-300 bg-white px-2 py-2 text-xs text-slate-700 hover:border-amber-700 focus-visible:outline-amber-700 disabled:opacity-50">{i + 1} · 查看位置</button>}
          <div className="min-w-0 flex-1"><button type="button" disabled={disabled || line.length > maxQueryLength || (target === 'label' && line.length < 2)} onClick={() => onSearch(line)}
          className="block w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-left text-sm text-emerald-800 hover:border-emerald-600 disabled:opacity-50 break-words">
          {line}<span className="mt-1 block text-xs text-slate-500">{line.length > maxQueryLength ? '此行太長，請先校正文字' : `以這行${target === 'pill' ? label : '完整文字'}查本機資料`}</span>
          </button>
          {target === 'label' && <OcrQuerySuggestion line={line} disabled={disabled} onSearch={onSearch} onEdit={onQueryEdit} />}
          </div></div>)}</div>
        {selectedLines.length > 0 && <div className="rounded-lg border border-emerald-200 bg-white p-3">
          <p className="text-xs text-slate-600">已選 {selectedLines.length} 行 · 請確認屬於{target === 'pill' ? '同一面刻字' : '同一品項'}</p>
          <p className="mt-1 break-words text-sm text-slate-800">{selectedLines.join(' ')}</p>
          {combinationError && <p className="mt-1 text-xs text-amber-800">{combinationError}</p>}
          <button type="button" disabled={disabled || !combined} onClick={() => onSearch(combined)} className="mt-2 rounded-lg bg-emerald-700 px-3 py-2 text-sm text-white disabled:opacity-50">{selectedLines.length < 2 ? '再選取一行即可合併查詢' : target === 'pill' ? '用完整刻字查本機資料' : '用選取文字查同一藥品'}</button>
          {combined && target === 'label' && <OcrQuerySuggestion line={combined} disabled={disabled} onSearch={onSearch} onEdit={onQueryEdit} />}
        </div>}
      </div>;
}
