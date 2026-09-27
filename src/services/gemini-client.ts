import { GoogleGenAI } from '@google/genai';

// Use the same model for key validation, OCR and text so access checks are meaningful.
export const GEMINI_MODEL = import.meta.env?.VITE_GEMINI_MODEL || 'gemini-3-flash-preview';

export function getGeminiClient(apiKey?: string) {
  const key = (apiKey || import.meta.env?.VITE_GEMINI_API_KEY || '').trim();
  if (!key) throw new Error('請先在「配置金鑰」輸入 Gemini 金鑰。您也可以直接輸入藥名搜尋。');
  return new GoogleGenAI({ apiKey: key });
}

export function geminiErrorMessage(error: unknown): string {
  const value = error as { status?: number; code?: number; message?: string } | null;
  let status = Number(value?.status || value?.code);
  let message = typeof value?.message === 'string' ? value.message : '';
  try {
    const details = JSON.parse(message)?.error;
    status ||= Number(details?.code);
    message = typeof details?.message === 'string' ? details.message : message;
  } catch { /* Network errors and SDK errors may have plain text messages. */ }
  if (status === 429) {
    return /limit:\s*0\b/i.test(message)
      ? '目前金鑰所屬專案沒有此 Gemini 模型的可用額度。請到 Google AI Studio 查看模型與額度設定，或改用手動藥名搜尋。'
      : 'Gemini 請求額度已用完或暫時超過速率限制，請到 Google AI Studio 查看額度，稍後再試。';
  }
  if (status === 401 || /API[_ ]KEY[_ ]INVALID|API key not valid|API key expired/i.test(message)) {
    return 'Gemini 金鑰無效或已過期，請重新配置金鑰。';
  }
  if (status === 403) return 'Gemini 拒絕存取，請確認金鑰的 API 權限、來源限制及服務可用地區。';
  if (status === 404) return '目前設定的 Gemini 模型無法使用，請檢查模型設定。';
  if (status >= 500) return 'Gemini 服務暫時無法使用，請稍後再試。';
  if (message.startsWith('請先在「配置金鑰」')) return message;
  return 'Gemini 請求失敗，請檢查網路與金鑰設定，或改用手動藥名搜尋。';
}
