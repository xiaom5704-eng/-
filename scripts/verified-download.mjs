import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, stat, writeFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

// Never bless a damaged cache by computing a new provenance hash from it.
export async function downloadVerified(url, destination, expectedHash, maxBytes, request = fetch) {
  if (!/^[a-f0-9]{64}$/.test(expectedHash) || !Number.isSafeInteger(maxBytes) || maxBytes < 1)
    throw new Error('下載檔案的校驗設定無效。');
  try {
    const size = (await stat(destination)).size;
    if (size > 0 && size <= maxBytes) {
      const cached = await readFile(destination);
      if (sha256(cached) === expectedHash) return cached;
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const bytes = await downloadBounded(url, maxBytes, request);
  if (sha256(bytes) !== expectedHash) throw new Error(`檔案校驗失敗，未覆寫本機檔案：${url}`);
  await mkdir(path.dirname(destination), { recursive: true });
  const pending = `${destination}.${randomUUID()}.partial`;
  try { await writeFile(pending, bytes); await rename(pending, destination); }
  finally { await rm(pending, { force: true }); }
  return bytes;
}

export async function downloadBounded(url, maxBytes, request = fetch, timeoutMs = 180_000) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error('下載大小限制無效。');
  const response = await request(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`下載失敗 ${response.status}: ${url}`); }
  if (!response.body || Number(response.headers.get('content-length')) > maxBytes) {
    await response.body?.cancel(); throw new Error(`來源檔案超出預期大小或沒有內容：${url}`);
  }
  const reader = response.body.getReader(), chunks = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.length;
      if (size > maxBytes) throw new Error(`來源檔案超出預期大小：${url}`);
      chunks.push(value);
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
  const bytes = Buffer.concat(chunks);
  if (!bytes.length) throw new Error(`來源檔案沒有內容：${url}`);
  return bytes;
}
