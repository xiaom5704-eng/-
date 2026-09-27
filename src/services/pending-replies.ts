import { sendJson } from './http';

export interface PendingReply {
  requestId: string; sessionId: string;
  userContent: string; assistantContent: string;
  question: string; answer: string;
  kind: 'chat' | 'symptoms' | 'medication';
  userMessageId?: number;
  newSessionTitle?: string;
}
export type PendingReplies = Record<string, PendingReply>;
const key = 'medsafe.pending-replies.v1';
type StorageAccess = () => Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function isPendingReply(item: unknown): item is PendingReply {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
  const value = item as Record<string, unknown>;
  return (value.userMessageId === undefined || (Number.isSafeInteger(value.userMessageId) && (value.userMessageId as number) > 0)) &&
    (value.newSessionTitle === undefined || (value.kind === 'medication' && typeof value.newSessionTitle === 'string' && !!value.newSessionTitle.trim() && value.newSessionTitle.length <= 2000)) &&
    ['chat', 'symptoms', 'medication'].includes(value.kind as string) && ['requestId', 'sessionId', 'userContent', 'assistantContent', 'question', 'answer'].every(name =>
    typeof value[name] === 'string' && !!value[name].trim() && value[name].length <= (name === 'requestId' || name === 'sessionId' ? 200 : 2_000_000));
}

// Tab-scoped recovery only. Never store API keys or send medical text to a
// provider while retrying persistence. Corrupt/unavailable storage cannot stop startup.
export function readPendingReplies(storage: StorageAccess): PendingReplies {
  try {
    const data: unknown = JSON.parse(storage().getItem(key) || '[]');
    if (!Array.isArray(data)) return {};
    return Object.fromEntries(data.filter(isPendingReply).map(reply => [reply.sessionId, reply]));
  } catch { return {}; }
}
export function writePendingReplies(storage: StorageAccess, replies: PendingReplies): boolean {
  try {
    const values = Object.values(replies);
    if (values.length) storage().setItem(key, JSON.stringify(values));
    else storage().removeItem(key);
    return true;
  } catch { return false; }
}
export const savePendingReply = (reply: PendingReply) => reply.kind === 'medication' ? sendJson(`/api/sessions/${encodeURIComponent(reply.sessionId)}/medication-report`, {
  requestId: reply.requestId, content: reply.assistantContent, newSessionTitle: reply.newSessionTitle,
}) : sendJson(`/api/sessions/${encodeURIComponent(reply.sessionId)}/exchange`, {
  requestId: reply.requestId, userContent: reply.userContent, assistantContent: reply.assistantContent,
  userMessageId: reply.userMessageId,
});
