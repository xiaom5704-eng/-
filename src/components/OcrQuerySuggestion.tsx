import { useState } from 'react';
import { suggestOcrQuery, type OcrQuerySuggestion as QuerySuggestion } from '../../shared/ocr-query';

export default function OcrQuerySuggestion({ line, disabled, onSearch, onEdit }: {
  line: string; disabled: boolean; onSearch: (query: string) => void; onEdit: () => void;
}) {
  const suggestion = suggestOcrQuery(line);
  return suggestion ? <QueryDraft key={line} suggestion={suggestion} disabled={disabled} onSearch={onSearch} onEdit={onEdit} /> : null;
}

function QueryDraft({ suggestion, disabled, onSearch, onEdit }: {
  suggestion: QuerySuggestion; disabled: boolean; onSearch: (query: string) => void; onEdit: () => void;
}) {
  const [query, setQuery] = useState(suggestion.query);
  return <details className="mt-1 rounded-lg border border-slate-200 bg-white p-3 text-xs text-slate-600">
    <summary className="cursor-pointer break-words font-medium text-emerald-800">建議查詢：{suggestion.query}（展開核對）</summary>
    <p className="mt-2 leading-relaxed">以下只是查詢文字建議，尚未查詢或確認藥品。請保留正確規格，核對原文是否屬於同一藥品。</p>
    <label className="mt-2 block">建議查詢文字
      <input aria-label="建議查詢文字" value={query} maxLength={120} disabled={disabled}
        onChange={e => { setQuery(e.target.value); onEdit(); }}
        className="mt-1 block w-full min-w-0 rounded-lg border border-slate-300 p-2 text-sm text-slate-800" />
    </label>
    <p className="mt-2 break-words">原文分出的欄位文字：{[suggestion.prefix, suggestion.suffix].filter(Boolean).join(' ／ ')}</p>
    {query !== suggestion.query && <p className="mt-1 text-amber-800">查詢文字已修改，請再核對原文的規格。</p>}
    <p className="mt-1 leading-relaxed">原辨識文字仍保留；這些用法、用量不會轉為服藥建議。</p>
    <button type="button" disabled={disabled || query.trim().length < 2 || query.trim().length > 120}
      onClick={() => onSearch(query.trim())} className="mt-2 rounded-lg bg-emerald-700 px-3 py-2 text-sm text-white disabled:opacity-50">用核對後藥名查詢</button>
  </details>;
}
