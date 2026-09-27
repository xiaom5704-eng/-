import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { DrugDatabase } from '../server/medications/store';
import { importTfdaLabelIndex, parseTfdaLabelIndex } from '../server/medications/tfda-label-index';

export const bundledLabelSha256 = '9203264e2a06ef872532aa33d44ce83ebcac1eed1ca49542d5826d903771ebe7';
export const bundledLabelRetrievedAt = '2026-09-27T14:49:31.588Z';
export const bundledLabelUrl = new URL('../resources/tfda/labels-2026-09-27.zip', import.meta.url);

export async function readBundledLabelIndex() {
  const bytes = await readFile(bundledLabelUrl);
  if (createHash('sha256').update(bytes).digest('hex') !== bundledLabelSha256) throw new Error('內附 TFDA 仿單索引校驗失敗');
  return bytes;
}

export async function applyTfdaLabelFile(filename: string, options: { bytes?: Buffer; retrievedAt?: string; backup?: boolean } = {}) {
  const bytes = options.bytes ?? await readBundledLabelIndex();
  const retrievedAt = options.bytes ? options.retrievedAt : bundledLabelRetrievedAt;
  if (!retrievedAt || !Number.isFinite(Date.parse(retrievedAt))) throw new Error('缺少仿單索引的取得日期');
  parseTfdaLabelIndex(bytes);
  const db = new Database(filename, { fileMustExist: true }) as DrugDatabase;
  let backupPath: string | undefined;
  try {
    db.pragma('busy_timeout = 5000');
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='tfda_drugs'").get() || !db.prepare('SELECT 1 FROM tfda_drugs LIMIT 1').get())
      throw new Error('請先安裝本機藥品主檔，再匯入仿單索引');
    if (options.backup) {
      const directory = path.join(path.dirname(path.resolve(filename)), 'backups');
      await mkdir(directory, { recursive: true });
      backupPath = path.join(directory, `before-tfda-labels-${Date.now()}-${randomUUID()}.db`);
      await db.backup(backupPath);
    }
    return { ...importTfdaLabelIndex(db, bytes, retrievedAt, { onlyIfMissing: !options.bytes }), backupPath };
  } finally { db.close(); }
}
