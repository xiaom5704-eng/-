import { randomUUID } from 'node:crypto';
import { renameSync } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { importDdinter, importTfda } from '../server/medications/importers';
import type { DrugDatabase } from '../server/medications/store';
import { downloadBounded, sha256 } from './verified-download.mjs';

export const drugDownloads = [
  { name: 'tfda.zip', url: 'https://data.fda.gov.tw/data/opendata/export/36/json' },
  ...['A', 'B', 'D', 'H', 'L', 'P', 'R', 'V'].map(code => ({ name: `ddinter_downloads_code_${code}.csv`,
    url: `https://ddinter2.scbdd.com/static/media/download/ddinter_downloads_code_${code}.csv` })),
];
export const snapshotName = 'drug-datasets.zip';
const fileLimit = 100 * 1024 * 1024, snapshotLimit = 200 * 1024 * 1024;
type RawFile = { name: string; data: Buffer };
type Manifest = { schema: 1; downloadedAt: string; files: { name: string; url: string; bytes: number; sha256: string }[] };

async function readBounded(filename: string, limit = fileLimit) {
  const size = (await stat(filename)).size;
  if (!size || size > limit) throw new Error(`離線資料大小異常：${path.basename(filename)}`);
  const data = await readFile(filename);
  if (data.length !== size) throw new Error(`讀取期間檔案變動，請重試：${path.basename(filename)}`);
  return data;
}

function validateTotal(files: RawFile[]) {
  if (files.reduce((total, file) => total + file.data.length, 0) > snapshotLimit) throw new Error('整批資料超出大小限制');
}

function unpackSnapshot(data: Buffer): RawFile[] {
  const zip = new AdmZip(data), entries = zip.getEntries();
  const manifestEntry = zip.getEntry('manifest.json');
  const names = new Set(entries.map(entry => entry.entryName));
  if (entries.length !== drugDownloads.length + 1 || names.size !== entries.length || !manifestEntry || manifestEntry.header.size > 64 * 1024)
    throw new Error('離線資料包的檔案清單異常，未更新資料庫');
  const manifest = JSON.parse(manifestEntry.getData().toString('utf8')) as Manifest;
  if (!manifest || manifest.schema !== 1 || !Array.isArray(manifest.files) || manifest.files.length !== drugDownloads.length ||
      !manifest.files.every(file => file && typeof file.name === 'string' && typeof file.url === 'string' && Number.isSafeInteger(file.bytes) && /^[a-f0-9]{64}$/.test(file.sha256)) ||
      typeof manifest.downloadedAt !== 'string' || !Number.isFinite(Date.parse(manifest.downloadedAt)))
    throw new Error('離線資料包版本或來源紀錄無效');
  const files = drugDownloads.map(source => {
    const entry = zip.getEntry(source.name), records = manifest.files.filter(file => file.name === source.name);
    const record = records[0];
    if (!entry || entry.isDirectory || !entry.header.size || entry.header.size > fileLimit || records.length !== 1 || record.url !== source.url || record.bytes !== entry.header.size)
      throw new Error(`離線資料包來源或大小不符：${source.name}`);
    return { entry, record };
  });
  if (files.reduce((total, file) => total + file.entry.header.size, 0) > snapshotLimit) throw new Error('離線資料包解壓後超出大小限制');
  return files.map(({ entry, record }) => {
    const bytes = entry.getData();
    if (bytes.length !== record.bytes || sha256(bytes) !== record.sha256) throw new Error(`離線檔案校驗失敗：${record.name}`);
    return { name: record.name, data: bytes };
  });
}

function packSnapshot(files: RawFile[]) {
  const zip = new AdmZip();
  const manifest: Manifest = { schema: 1, downloadedAt: new Date().toISOString(), files: files.map(file => ({
    name: file.name, url: drugDownloads.find(source => source.name === file.name)!.url, bytes: file.data.length, sha256: sha256(file.data),
  })) };
  for (const file of files) zip.addFile(file.name, file.data);
  zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2)));
  const data = zip.toBuffer();
  if (data.length > snapshotLimit) throw new Error('離線資料包超出大小限制');
  return data;
}

async function readOffline(directory: string) {
  try { return unpackSnapshot(await readBounded(path.join(directory, snapshotName), snapshotLimit)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  // Existing installations retain their original loose files. Never silently use
  // them when a newer bundle exists but fails integrity validation.
  try {
    const files: RawFile[] = [];
    for (const source of drugDownloads) { files.push({ name: source.name, data: await readBounded(path.join(directory, source.name)) }); validateTotal(files); }
    return files;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('離線資料不完整；需先成功執行 npm run data:sync，或備妥 TFDA ZIP 與全部八類 DDInter CSV。');
    throw error;
  }
}

export async function syncDrugData(db: DrugDatabase, options: {
  directory: string; offline?: boolean; request?: typeof fetch; log?: (message: string) => void;
}) {
  const directory = path.resolve(options.directory), destination = path.join(directory, snapshotName);
  const files: RawFile[] = [];
  if (options.offline) files.push(...await readOffline(directory));
  else for (const source of drugDownloads) {
    options.log?.(`下載 ${source.name}`);
    files.push({ name: source.name, data: await downloadBounded(source.url, fileLimit, options.request, 60_000) });
    validateTotal(files);
  }
  const zip = new AdmZip(files[0].data), entries = zip.getEntries().filter(entry => entry.entryName.endsWith('.json'));
  if (entries.length !== 1 || entries[0].header.size > snapshotLimit) throw new Error('TFDA ZIP 格式異常');
  const tfda = JSON.parse(entries[0].getData().toString('utf8').replace(/^\uFEFF/, ''));
  const ddinter = files.slice(1).map(file => ({ name: file.name, csv: file.data.toString('utf8') }));
  const pending = options.offline ? undefined : path.join(directory, `${snapshotName}.${randomUUID()}.partial`);
  try {
    if (pending) {
      await mkdir(directory, { recursive: true });
      await writeFile(pending, packSnapshot(files), { flag: 'wx' });
    }
    return db.transaction(() => {
      const statuses = [importTfda(db, tfda), importDdinter(db, ddinter)];
      // Publish only semantically valid, complete sources as one atomic file.
      // Publication failure rolls back SQL; a crash after rename still leaves a
      // complete valid bundle that --offline can reimport, never mixed versions.
      if (pending) renameSync(pending, destination);
      return statuses;
    })();
  } finally { if (pending) await rm(pending, { force: true }); }
}
