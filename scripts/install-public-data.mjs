import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import AdmZip from 'adm-zip';

export const publicDataUrl = 'https://github.com/xiaom5704-eng/-/releases/download/demo-2026-09-27/medsafe-public-data-2026-09-27.zip';
export const publicDataSha256 = 'a5017ea7a5c2b3a7b3852300f16af2dc90a1db2c2c5a375fbb0e5d90647c1dea';
const maxArchiveBytes = 170 * 1024 * 1024;
const required = ['drugs.db', 'vision/index.db', 'vision/models/Xenova/dinov2-small/config.json',
  'vision/models/Xenova/dinov2-small/preprocessor_config.json', 'vision/models/Xenova/dinov2-small/onnx/model_quantized.onnx'];
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

async function requireNewDataDirectory(destination) {
  try { await lstat(destination); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  throw new Error('data 已存在，未覆蓋。請保留既有資料；首次安裝請在新的專案資料夾執行。');
}

function safeRelative(value) {
  return typeof value === 'string' && value.length > 0 && !/[\\:\0]/.test(value) &&
    value.split('/').every(part => part && part !== '.' && part !== '..' && !/[. ]$/.test(part));
}

// The CLI fixes the URL and hash. Injected values are used only by isolated tests.
export async function installPublicData({ projectRoot, archivePath = '', download = fetch, expectedHash = publicDataSha256, onProgress = () => {}, prepareData = async (_directory) => {} }) {
  const root = path.resolve(projectRoot), destination = path.join(root, 'data');
  await requireNewDataDirectory(destination);
  const staging = path.join(root, `.data-install-${randomUUID()}`);
  await mkdir(staging);
  try {
    const archive = archivePath ? path.resolve(archivePath) : path.join(staging, 'public-data.zip');
    if (!archivePath) {
      onProgress('正在下載約 160 MB 的公開參考資料；不需要 API Key。');
      const response = await download(publicDataUrl, { signal: AbortSignal.timeout(600_000) });
      if (!response.ok || !response.body) throw new Error(`資料包下載失敗：HTTP ${response.status}。可先下載 ZIP，再用 --file 指定本機檔案。`);
      let bytes = 0, reported = 0;
      const limit = new Transform({ transform(chunk, _encoding, callback) {
        bytes += chunk.length;
        if (bytes - reported >= 16 * 1024 * 1024) { reported = bytes; onProgress(`已下載 ${(bytes / 1024 / 1024).toFixed(0)} MiB…`); }
        callback(bytes > maxArchiveBytes ? new Error('資料包超過預期大小，停止安裝。') : null, chunk);
      } });
      await pipeline(Readable.fromWeb(response.body), limit, createWriteStream(archive, { flags: 'wx' }));
    }
    const size = (await stat(archive)).size;
    if (!size || size > maxArchiveBytes) throw new Error('資料包大小無效。');
    const digest = createHash('sha256');
    for await (const chunk of createReadStream(archive)) digest.update(chunk);
    if (digest.digest('hex') !== expectedHash) throw new Error('資料包 SHA-256 不符，未安裝。請重新下載指定版本。');
    onProgress('下載完整性通過，正在逐檔核對並安裝本機資料。');
    const zip = new AdmZip(archive), entries = zip.getEntries(), files = new Map();
    const names = new Set(); let expandedBytes = 0;
    for (const entry of entries) {
      const name = entry.isDirectory ? entry.entryName.slice(0, -1) : entry.entryName;
      if (!safeRelative(name) || (!entry.isDirectory && name === 'data') || (name !== 'data' && !name.startsWith('data/')) ||
          names.has(name.toLowerCase()) || ((entry.attr >>> 16) & 0xf000) === 0xa000) throw new Error('資料包含不合法或重複路徑。');
      names.add(name.toLowerCase());
      if (!entry.isDirectory) {
        expandedBytes += entry.header.size;
        if (expandedBytes > 400 * 1024 * 1024 || files.size >= 10_000) throw new Error('解壓縮資料超過預期範圍。');
        files.set(name.slice('data/'.length), entry);
      }
    }
    const manifestEntry = files.get('manifest.json');
    if (!manifestEntry || manifestEntry.header.size > 2 * 1024 * 1024) throw new Error('缺少有效的資料清單。');
    const manifestBytes = manifestEntry.getData(), manifest = JSON.parse(manifestBytes.toString('utf8'));
    if (manifest.schema !== 1 || !Array.isArray(manifest.verify) || manifest.verify.length !== files.size - 1) throw new Error('資料清單不完整。');
    const expected = new Map();
    for (const item of manifest.verify) {
      if (!safeRelative(item?.path) || item.path === 'manifest.json' || expected.has(item.path) ||
          !/^[a-f0-9]{64}$/.test(item.sha256) || !files.has(item.path)) throw new Error('資料清單路徑或雜湊無效。');
      expected.set(item.path, item.sha256);
    }
    if (!required.every(file => expected.has(file))) throw new Error('資料包缺少藥品、圖片索引或模型。');
    const nextData = path.join(staging, 'data');
    for (const [relative, digest] of expected) {
      const bytes = files.get(relative).getData();
      if (sha256(bytes) !== digest) throw new Error(`檔案校驗失敗：${relative}，未安裝。`);
      const target = path.resolve(nextData, relative);
      if (!target.startsWith(nextData + path.sep)) throw new Error('資料清單路徑超出安裝目錄。');
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, bytes, { flag: 'wx' });
    }
    await writeFile(path.join(nextData, 'manifest.json'), manifestBytes, { flag: 'wx' });
    // Enrichment runs only after base verification and before atomic publication.
    await prepareData(nextData);
    await requireNewDataDirectory(destination);
    await rename(nextData, destination);
    return { directory: destination, verifiedFiles: expected.size, preparedAt: manifest.preparedAt };
  } finally {
    if (path.dirname(staging) !== root || !/^\.data-install-[a-f0-9-]{36}$/.test(path.basename(staging))) throw new Error('暫存清理路徑無效。');
    await rm(staging, { recursive: true, force: true });
  }
}
