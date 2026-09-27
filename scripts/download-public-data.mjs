import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { lstat, mkdir, readFile, readdir, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
class InvalidDownload extends Error {}

async function readRange(response, start, end, total, signal, progress) {
  const size = end - start + 1, length = response.headers.get('content-length');
  const encoding = response.headers.get('content-encoding');
  try {
    if (!response.ok) {
      const error = new Error(`資料來源 HTTP ${response.status}`);
      if (![408, 429].includes(response.status) && response.status < 500) throw new InvalidDownload(error.message);
      throw error;
    }
    if (!response.body || (encoding && encoding !== 'identity') ||
        (length !== null && (!/^\d+$/.test(length) || Number(length) !== size)) ||
        (response.status === 206 ? response.headers.get('content-range') !== `bytes ${start}-${end}/${total}`
          : !(response.status === 200 && start === 0 && end === total - 1)))
      throw new InvalidDownload('資料來源未回傳正確的下載分段，未合併檔案。');
  } catch (error) { await response.body?.cancel().catch(() => {}); throw error; }
  const reader = response.body.getReader(), chunks = []; let received = 0;
  const cancel = () => { void reader.cancel(signal.reason).catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    for (;;) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      received += value.length;
      if (received > size) throw new InvalidDownload('下載分段超過預期大小。');
      chunks.push(Buffer.from(value)); progress(received);
    }
    if (received !== size) throw new Error('下載分段不完整。');
    return Buffer.concat(chunks);
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { signal.removeEventListener('abort', cancel); reader.releaseLock(); }
}

// Completed chunks are untrusted until both their saved digest and the pinned whole-file digest pass.
// A completed write is published atomically; interrupted .pending files are never reused.
export async function downloadPublicArchive({ url, archive, projectRoot, expectedHash, expectedBytes,
  download = fetch, onProgress = () => {}, signal = undefined, chunkBytes = 4 * 1024 * 1024,
  concurrency = 3, attempts = 3, requestTimeoutMs = 180_000, retryDelayMs = 1_000 }) {
  if (!/^[a-f0-9]{64}$/.test(expectedHash) || !Number.isSafeInteger(expectedBytes) || expectedBytes < 1 || expectedBytes > 300 * 1024 * 1024 ||
      !Number.isSafeInteger(chunkBytes) || chunkBytes < 1 || chunkBytes > 8 * 1024 * 1024 ||
      !Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4 ||
      !Number.isInteger(attempts) || attempts < 1 || attempts > 3 ||
      !Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1 || !Number.isInteger(retryDelayMs) || retryDelayMs < 0)
    throw new Error('下載資料包的校驗或分段設定無效。');
  signal?.throwIfAborted();
  const cache = path.join(path.resolve(projectRoot), `.data-download-${expectedHash}`);
  await mkdir(cache, { recursive: true });
  const directory = await lstat(cache);
  if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('下載快取必須是專案內的一般資料夾。');
  const entries = await readdir(cache), parts = [], inflight = new Map();
  let completed = 0, lastReport = Date.now(), next = 0;
  const controller = new AbortController();
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const report = (force = false) => {
    if (!force && Date.now() - lastReport < 5_000) return;
    lastReport = Date.now();
    const received = completed + [...inflight.values()].reduce((sum, value) => sum + value, 0);
    onProgress(`已下載 ${(received / 1024 / 1024).toFixed(1)} / ${(expectedBytes / 1024 / 1024).toFixed(1)} MiB（${Math.floor(received / expectedBytes * 100)}%）`);
  };
  try {
    for (let start = 0; start < expectedBytes; start += chunkBytes) {
      combined.throwIfAborted();
      const end = Math.min(start + chunkBytes, expectedBytes) - 1, part = { start, end, file: '' };
      const prefix = `${start}-${end}-`;
      for (const entry of entries.filter(name => name.startsWith(prefix) && /^[a-f0-9]{64}\.part$/.test(name.slice(prefix.length)))) {
        const file = path.join(cache, entry), status = await lstat(file);
        if (!status.isFile() || status.isSymbolicLink()) throw new Error('下載快取包含不合法的檔案。');
        if (status.size === end - start + 1 && hash(await readFile(file)) === entry.slice(prefix.length, -5)) {
          part.file = file; completed += status.size; break;
        }
        await rm(file); // Only the exact regular cache file above, never an arbitrary directory.
      }
      parts.push(part);
    }
    if (completed) onProgress(`已核對並沿用 ${(completed / 1024 / 1024).toFixed(1)} MiB 的完整分段，繼續下載剩餘資料。`);
    const pending = parts.filter(part => !part.file);
    async function worker() {
      while (next < pending.length) {
        combined.throwIfAborted();
        const part = pending[next++];
        for (let attempt = 1; ; attempt++) {
          combined.throwIfAborted();
          try {
            const requestSignal = AbortSignal.any([combined, AbortSignal.timeout(requestTimeoutMs)]);
            const response = await download(url, { headers: { Range: `bytes=${part.start}-${part.end}`, 'Accept-Encoding': 'identity' }, signal: requestSignal });
            const bytes = await readRange(response, part.start, part.end, expectedBytes, requestSignal,
              count => { inflight.set(part.start, count); report(); });
            combined.throwIfAborted();
            const file = path.join(cache, `${part.start}-${part.end}-${hash(bytes)}.part`);
            const pendingFile = path.join(cache, `${randomUUID()}.pending`);
            try {
              await writeFile(pendingFile, bytes, { flag: 'wx' });
              try { await rename(pendingFile, file); }
              catch (error) {
                // Windows may refuse replacing a file another installer has just published.
                // Reuse only identical complete content; never remove the other writer's file.
                if (!['EEXIST', 'EPERM'].includes(error.code)) throw error;
                const existing = await lstat(file);
                if (!existing.isFile() || existing.isSymbolicLink() || existing.size !== bytes.length || hash(await readFile(file)) !== hash(bytes)) throw error;
              }
            }
            catch (error) { throw new InvalidDownload(`無法保存下載分段（${error.code || '檔案寫入失敗'}），請檢查可用磁碟空間與資料夾權限`); }
            finally { await rm(pendingFile, { force: true }); }
            part.file = file; inflight.delete(part.start); completed += bytes.length; report(); break;
          } catch (error) {
            inflight.delete(part.start);
            if (combined.aborted || error instanceof InvalidDownload || attempt >= attempts) throw error;
            onProgress(`分段 ${Math.floor(part.start / chunkBytes) + 1} 下載中斷，重試 ${attempt}/${attempts - 1}…`);
            await delay(retryDelayMs * attempt, undefined, { signal: combined });
          }
        }
      }
    }
    const workers = Array.from({ length: Math.min(concurrency, pending.length) }, () => worker().catch(error => { controller.abort(error); throw error; }));
    const outcomes = await Promise.allSettled(workers);
    const failed = outcomes.find(outcome => outcome.status === 'rejected');
    if (failed) throw controller.signal.reason || failed.reason;
    combined.throwIfAborted(); report(true);
    const digest = createHash('sha256');
    const source = Readable.from((async function* () {
      for (const part of parts) { combined.throwIfAborted(); const bytes = await readFile(part.file); digest.update(bytes); yield bytes; }
    })());
    await pipeline(source, createWriteStream(archive, { flags: 'wx' }), { signal: combined });
    if (digest.digest('hex') !== expectedHash) {
      // Content assembled from these chunks failed the pinned checksum. Do not reuse them.
      for (const part of parts) await rm(part.file, { force: true });
      await rm(archive, { force: true });
      throw new InvalidDownload('資料包 SHA-256 不符，已清除本次分段，未安裝。');
    }
    return { cacheDirectory: cache, bytes: completed };
  } catch (error) {
    await rmdir(cache).catch(() => {}); // Remove only an empty cache, retaining completed chunks for retry.
    if (signal?.aborted) throw signal.reason;
    throw new Error(`資料包下載未完成：${error instanceof Error ? error.message : '連線失敗'}。完整分段會保留；重新執行 npm run data:install 可接續，或用 --file 安裝已下載的 ZIP。`, { cause: error });
  }
}
