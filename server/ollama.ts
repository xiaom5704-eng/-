import { Router } from 'express';

type OllamaOptions = { baseUrl?: string; model?: string; timeoutMs?: number; fetcher?: typeof fetch };
function positiveInteger(value: unknown, fallback: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function ollamaRouter(options: OllamaOptions = {}) {
  const router = Router();
  const baseUrl = (options.baseUrl || process.env.OLLAMA_API_BASE_URL || 'http://localhost:11434').replace(/\/$/, '');
  const model = options.model || process.env.OLLAMA_MODEL || 'llama3.2:3b';
  const timeoutMs = options.timeoutMs || positiveInteger(process.env.OLLAMA_TIMEOUT_MS, 300_000);
  const fetcher = options.fetcher || fetch;

  router.post('/', async (req, res) => {
    if (typeof req.body?.prompt !== 'string' || !req.body.prompt.trim() || (req.body.system !== undefined && typeof req.body.system !== 'string')) {
      res.status(400).json({ error: '請輸入有效的問題內容。', code: 'INVALID_PROMPT' }); return;
    }
    const disconnected = new AbortController();
    const onClose = () => { if (!res.writableEnded) disconnected.abort(); };
    res.once('close', onClose);
    const signal = AbortSignal.any([disconnected.signal, AbortSignal.timeout(timeoutMs)]);
    try {
      const response = await fetcher(`${baseUrl}/api/generate`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal,
        body: JSON.stringify({
          model, prompt: req.body.prompt, system: req.body.system || '', stream: false,
          think: process.env.OLLAMA_THINK === 'false' ? false : process.env.OLLAMA_THINK === 'true' ? true : undefined,
          options: process.env.OLLAMA_CONTEXT_SIZE ? { num_ctx: positiveInteger(process.env.OLLAMA_CONTEXT_SIZE, 4096) } : undefined,
        }),
      });
      const data = await response.json().catch(error => { if (signal.aborted) throw error; return null; });
      signal.throwIfAborted();
      if (!response.ok) {
        if (response.status === 404) {
          res.status(503).json({ error: `Ollama 找不到設定的模型 ${model}，請確認模型已下載。`, code: 'OLLAMA_MODEL_MISSING' }); return;
        }
        const memoryError = typeof data?.error === 'string' && /memory|out of memory/i.test(data.error);
        res.status(502).json({ error: memoryError
          ? 'Ollama 可連線，但記憶體不足以執行模型。請關閉其他程式或使用較小的模型。'
          : `Ollama 可連線，但模型執行失敗（HTTP ${response.status}），請稍後再試。`, code: 'OLLAMA_GENERATION_FAILED' }); return;
      }
      if (typeof data?.response !== 'string' || !data.response.trim()) {
        res.status(502).json({ error: 'Ollama 已回應，但沒有產生回答文字，請重試。', code: 'OLLAMA_EMPTY_RESPONSE' }); return;
      }
      res.json(data);
    } catch (error) {
      if (disconnected.signal.aborted) return;
      if (signal.aborted || (error as Error)?.name === 'TimeoutError' || (error as Error)?.name === 'AbortError') {
        res.status(504).json({ error: `本機模型未在 ${Math.round(timeoutMs / 1000)} 秒內完成回覆，這不代表 Ollama 未啟動。請稍後重試、縮短問題，或改用 Gemini。`, code: 'OLLAMA_TIMEOUT' });
      } else {
        res.status(503).json({ error: '無法連到 Ollama 背景服務，請啟動 Ollama 或檢查服務位址。', code: 'OLLAMA_UNREACHABLE' });
      }
    } finally { res.off('close', onClose); }
  });

  router.get('/status', async (_req, res) => {
    try {
      const response = await fetcher(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(2000) });
      const data = await response.json();
      const installed = response.ok && Array.isArray(data.models) && data.models.some((item: { name: string }) => item.name === model);
      res.json({ status: installed ? 'online' : 'offline', model });
    } catch {
      res.json({ status: 'offline', model });
    }
  });
  return router;
}
