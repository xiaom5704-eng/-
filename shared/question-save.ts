export interface QuestionSaveAttempt {
  requestId: string;
  sessionId: string;
  originSessionId: string | null;
  content: string;
  newSessionTitle?: string;
}

// Keep the same identity until the server confirms this exact question. Changing
// the text/age or choosing another conversation starts a separate operation.
export function questionSaveAttempt(content: string, sessionId: string | null, previous: QuestionSaveAttempt | null,
  newId: () => string = () => crypto.randomUUID()): QuestionSaveAttempt {
  if (previous?.originSessionId === sessionId && previous.content === content) return previous;
  return { content, originSessionId: sessionId, requestId: newId(), sessionId: sessionId || newId(),
    ...(!sessionId ? { newSessionTitle: `新對話 ${new Date().toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' })}` } : {}) };
}
