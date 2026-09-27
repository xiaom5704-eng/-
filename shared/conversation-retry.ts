type StoredMessage = { id?: number; session_id: string; role: string; content: string; client_id?: string | null };

// Old databases have no client ID. A stable ID tied to the existing row allows
// retrying their final question without copying it into a new user message.
export function replyRequestId(message: Pick<StoredMessage, 'id' | 'client_id'>): string {
  return message.client_id?.endsWith(':user') ? message.client_id.slice(0, -5) : `reply-${message.id}`;
}

export function unansweredQuestion<T extends StoredMessage>(messages: T[], sessionId: string | null) {
  const last = messages.at(-1);
  if (!sessionId || !last || last.session_id !== sessionId || last.role !== 'user' ||
      !Number.isSafeInteger(last.id) || last.id! <= 0 || !last.content.trim()) return null;
  const requestId = replyRequestId(last);
  if (!requestId.trim() || requestId.length > 200) return null;
  return { message: last, requestId, history: messages.slice(0, -1) };
}
