import { requestJson } from './http';
import { GEMINI_MODEL, getGeminiClient, geminiErrorMessage } from './gemini-client';
import { consultationInstruction } from '../../shared/consultation';

export type Engine = 'gemini' | 'ollama';
// The displayed selection is the only destination, including background titles.
// A configured key is not permission to silently switch a local request to cloud.
export async function withSelectedAI(engine: Engine, providers: Record<Engine, () => Promise<string | null | undefined>>, required = false, signal?: AbortSignal) {
  signal?.throwIfAborted();
  try {
    const result = await providers[engine]();
    signal?.throwIfAborted();
    if (typeof result === 'string' && result.trim()) return result.trim();
    if (required) throw new Error('沒有產生回答文字，請重試或在上方切換引擎。');
    return null;
  } catch (error) {
    signal?.throwIfAborted();
    if (required) throw new Error(`${engine === 'gemini' ? 'Gemini' : 'Ollama'}：${error instanceof Error ? error.message : '請求失敗，請稍後重試。'}`);
    return null;
  }
}

const callOllama = async (prompt: string, system?: string, signal?: AbortSignal) => {
  try {
    const data = await requestJson<{ response: string }>('/api/ai/ollama', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt, system }), signal,
    });
    return data.response;
  } catch (error) {
    if (error instanceof TypeError) throw new Error('無法連到應用程式後端，請確認專案仍在執行。');
    throw error;
  }
};

type ConversationMessage = { role: string; content: string };

export const getSymptomAdvice = async (symptoms: string, mode: 'concise' | 'detailed', apiKey?: string, selectedEngine: Engine = 'gemini', history: ConversationMessage[] = [], signal?: AbortSignal) => {
  const format = mode === 'concise'
    ? '請針對本次症狀提供 200 字以內的一般照護資訊與就醫警訊。'
    : '請針對本次症狀分段提供一般居家照護資訊、需要補充的資料與就醫警訊，不把可能原因當成診斷。';
  return medicalReply(history, `症狀描述：\n${symptoms}`, `${consultationInstruction}\n${format}`, apiKey, selectedEngine, signal);
};

export const chatWithAI = async (history: ConversationMessage[], message: string, apiKey?: string, selectedEngine: Engine = 'gemini', signal?: AbortSignal) =>
  medicalReply(history, message, consultationInstruction, apiKey, selectedEngine, signal);

async function medicalReply(history: ConversationMessage[], message: string, systemInstruction: string, apiKey: string | undefined, selectedEngine: Engine, signal?: AbortSignal) {

  const tryOllama = async () => {
    const prompt = history.map(h => `${h.role === 'user' ? 'User' : 'Assistant'}: ${h.content}`).join('\n') + `\nUser: ${message}`;
    return await callOllama(prompt, systemInstruction, signal);
  };

  const tryGemini = async () => {
    try {
      const collapsedHistory: { role: 'user' | 'model', parts: { text: string }[] }[] = [];
      for (const h of history) {
        const role = h.role === 'user' ? 'user' : 'model';
        if (collapsedHistory.length > 0 && collapsedHistory[collapsedHistory.length - 1].role === role) {
          collapsedHistory[collapsedHistory.length - 1].parts[0].text += `\n\n${h.content}`;
        } else {
          collapsedHistory.push({ role, parts: [{ text: h.content }] });
        }
      }

      if (collapsedHistory.length > 0 && collapsedHistory[0].role === 'model') {
        collapsedHistory.unshift({ role: 'user', parts: [{ text: '[系統提示：對話開始]' }] });
      }

      if (collapsedHistory.length > 0 && collapsedHistory[collapsedHistory.length - 1].role === 'user') {
        collapsedHistory[collapsedHistory.length - 1].parts[0].text += `\n\n${message}`;
      } else {
        collapsedHistory.push({ role: 'user', parts: [{ text: message }] });
      }

      const ai = getGeminiClient(apiKey);
      const response = await ai.models.generateContent({
        model: GEMINI_MODEL,
        contents: collapsedHistory,
        config: { systemInstruction, abortSignal: signal }
      });
      return response.text;
    } catch (e) {
      signal?.throwIfAborted();
      throw new Error(geminiErrorMessage(e));
    }
  };

  return withSelectedAI(selectedEngine, { gemini: tryGemini, ollama: tryOllama }, true, signal);
}

export const testGeminiKey = async (apiKey: string, signal?: AbortSignal): Promise<boolean> => {
  signal?.throwIfAborted();
  try {
    const ai = getGeminiClient(apiKey);
    await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: "Reply with OK only.",
      config: { maxOutputTokens: 8, abortSignal: signal }
    });
    // A successful request validates access even when a tiny output budget yields no text.
    signal?.throwIfAborted(); return true;
  } catch (error) {
    signal?.throwIfAborted();
    throw new Error(geminiErrorMessage(error));
  }
};

export const generateTitleSummary = async (userMessage: string, aiResponse: string, apiKey?: string, selectedEngine: 'gemini' | 'ollama' = 'gemini') => {
  const prompt = `請根據以下對話內容，生成一個 10-15 字的簡短標題，用於對話列表。
使用者：${userMessage}
AI：${aiResponse}

要求：
1. 只需回傳標題文字，不要有引號或額外說明。
2. 必須強制使用繁體中文，禁止出現簡體字。`;

  const tryGemini = async () => {
    try {
      if (!apiKey && !import.meta.env?.VITE_GEMINI_API_KEY) return null;
      const ai = getGeminiClient(apiKey);
      const response = await ai.models.generateContent({
        model: GEMINI_MODEL,
        contents: [{ parts: [{ text: prompt }] }]
      });
      return response.text?.trim() || null;
    } catch {
      return null;
    }
  };

  return withSelectedAI(selectedEngine, { gemini: tryGemini, ollama: () => callOllama(prompt) });
}
