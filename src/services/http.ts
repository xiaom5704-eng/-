export async function requestJson<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, options);
  const body = await response.json().catch(() => { options?.signal?.throwIfAborted(); return null; });
  options?.signal?.throwIfAborted();
  if (!response.ok) {
    throw new Error(typeof body?.error === 'string' ? body.error : `請求失敗（${response.status}），請稍後重試。`);
  }
  if (body === null) throw new Error('伺服器回傳格式不正確，請稍後重試。');
  return body;
}

export const sendJson = <T = { success: boolean }>(url: string, body: unknown, method = 'POST') =>
  requestJson<T>(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
