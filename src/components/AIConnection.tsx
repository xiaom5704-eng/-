import { useCallback, useEffect, useRef, useState } from 'react';
import type { OllamaStatus } from '../../shared/ai-status';
import type { Engine } from '../services/gemini';
import { requestJson } from '../services/http';

export default function AIConnection({ engine, onChange, onConfigure, geminiValid, disabled }: {
  engine: Engine; onChange: (engine: Engine) => void; onConfigure: () => void; geminiValid: boolean; disabled: boolean;
}) {
  const [status, setStatus] = useState<OllamaStatus | null>(null);
  const [checking, setChecking] = useState(true), [error, setError] = useState('');
  const current = useRef<AbortController | null>(null);
  const refresh = useCallback(async () => {
    current.current?.abort();
    const controller = new AbortController(); current.current = controller; setChecking(true);
    try {
      const result = await requestJson<OllamaStatus>('/api/ai/ollama/status', { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]) });
      if (controller.signal.aborted) return;
      setStatus(result); setError('');
    } catch {
      if (controller.signal.aborted) return;
      setStatus(null); setError('無法取得應用程式的連線狀態，請確認本機專案仍在執行，再重新檢查。');
    } finally { if (!controller.signal.aborted) setChecking(false); }
  }, []);
  useEffect(() => {
    void refresh(); const timer = setInterval(() => void refresh(), 30_000);
    return () => { clearInterval(timer); current.current?.abort(); };
  }, [refresh]);
  const online = status?.status === 'online';
  return <div className="w-full space-y-2 sm:w-auto" aria-label="AI 回答引擎設定">
    <div className="flex flex-wrap items-center gap-2">
      <div role="group" aria-label="選擇回答引擎" className="flex gap-1 rounded-xl bg-slate-100 p-1 text-xs font-medium">
        {(['ollama', 'gemini'] as const).map(value => <button key={value} type="button" disabled={disabled}
          aria-pressed={engine === value} onClick={() => onChange(value)}
          className={`min-h-10 rounded-lg border px-3 py-2 disabled:opacity-60 ${engine === value ? 'border-emerald-200 bg-white text-emerald-800 shadow-sm' : 'border-transparent text-slate-600'}`}>
          {value === 'ollama' ? 'Ollama' : 'Gemini 雲端'}
        </button>)}
      </div>
      <p className="text-xs text-slate-600" role="status">
        {engine === 'gemini' ? `Gemini · ${geminiValid ? '金鑰已測試' : '金鑰未測試'}`
          : `Ollama · ${checking ? '檢查中' : online ? '模型已安裝' : status?.code === 'model_missing' ? '模型未安裝' : '未就緒'}`}
      </p>
    </div>
    <div className="flex flex-wrap items-start justify-between gap-2">
    <details className="max-w-xl flex-1 text-xs text-slate-600">
      <summary className="cursor-pointer py-2">連線狀態與使用方式</summary>
      <div className="mt-2 max-h-52 space-y-2 overflow-y-auto rounded-lg border border-slate-200 bg-slate-50 p-3 leading-relaxed">
        <p>聊天、症狀回答與自動標題只使用您選擇的引擎。失敗後可切換，再重試原問題；不會自動改用另一個引擎。</p>
        <p>本機查藥、交互作用、CV 與 OCR 可獨立使用，不需 Ollama 或 Gemini 金鑰。</p>
        <p className="break-words">Ollama 設定模型：<strong>{status?.model || '尚未取得'}</strong></p>
        <p role={error || status?.status === 'offline' ? 'alert' : undefined}>{error || status?.message || '正在讀取連線狀態…'}</p>
        {status?.code === 'model_missing' && <p className="break-words">已安裝：{status.installedModels.length ? status.installedModels.join('、') : '目前沒有模型'}。可在 VS Code 終端機執行 <code>ollama list</code> 核對名稱。</p>}
        <button type="button" onClick={() => void refresh()} disabled={checking} className="min-h-10 rounded-lg border border-slate-300 bg-white px-3 py-2 text-slate-700 disabled:opacity-60">{checking ? '檢查中…' : '重新檢查 Ollama'}</button>
        <p>Ollama 依專案後端設定連線；模型已安裝不保證記憶體足夠或回覆成功。Gemini 會將本次問題與對話內容送至 Google，需可用金鑰。</p>
      </div>
    </details>
    <button type="button" disabled={disabled} onClick={onConfigure} className="shrink-0 rounded-lg border border-slate-200 bg-slate-100 px-3 py-2 text-xs text-slate-700 hover:bg-slate-200 disabled:opacity-50">配置金鑰</button>
    </div>
  </div>;
}
