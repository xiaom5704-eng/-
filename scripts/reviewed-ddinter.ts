import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DrugDatabase } from '../server/medications/store';
import { ddinterDrugUrl, ddinterGraphUrl, initializeDdinterSupplements, importDdinterGraph, parseDdinterGraph } from '../server/medications/ddinter-supplements';

export const reviewedDdinterSha256 = 'e9ea056b6330b4e286e3fab012156a8d57d780145fc615f7beb8584a5f66bd45';
const bundleUrl = new URL('../resources/ddinter/missing-ingredients-2026-09-27.json', import.meta.url);
const maxBytes = 2 * 1024 * 1024;
const hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
interface Archive { schema: 1; id: string; name: string; retrievedAt: string; sourceUrl: string; dataUrl: string; sha256: string; raw: string }

// The distributed file is pinned. An alternate hash is only for isolated fixtures.
export function parseReviewedDdinter(bytes: Buffer, expectedHash = reviewedDdinterSha256): Archive[] {
  if (!bytes.length || bytes.length > maxBytes || hash(bytes) !== expectedHash) throw new Error('DDInter 補充資料大小或 SHA-256 不符，未補入。');
  const value = JSON.parse(bytes.toString('utf8'));
  if (value?.schema !== 1 || value.id !== 'ddinter-missing-ingredients-2026-09-27' ||
      value.license !== 'CC BY-NC-SA 4.0' || value.termsUrl !== 'https://ddinter2.scbdd.com/terms/' ||
      typeof value.attribution !== 'string' || !value.attribution.trim() ||
      !Array.isArray(value.archives) || !value.archives.length || value.archives.length > 100)
    throw new Error('DDInter 補充資料格式或來源聲明無效，未補入。');
  const seen = new Set<string>();
  for (const item of value.archives) {
    if (item?.schema !== 1 || typeof item.id !== 'string' || !/^DDInter\d+$/.test(item.id) || seen.has(item.id) ||
        item.sourceUrl !== ddinterDrugUrl(item.id) || item.dataUrl !== ddinterGraphUrl(item.id) ||
        typeof item.retrievedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(item.retrievedAt) || !Number.isFinite(Date.parse(item.retrievedAt)) ||
        typeof item.raw !== 'string' || hash(item.raw) !== item.sha256 || parseDdinterGraph(item.raw, item.id).name !== item.name)
      throw new Error('DDInter 補充資料含重複成分、損毀內容或不符的來源，未補入。');
    seen.add(item.id);
  }
  return value.archives;
}

function requireBaseData(db: DrugDatabase) {
  for (const table of ['tfda_drugs', 'ddinter_drugs', 'ddinter_pairs']) {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table) || !db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get())
      throw new Error('請先安裝本機 TFDA 與 DDInter 基本資料，再補入已核對快照。');
  }
}

export function applyReviewedDdinter(db: DrugDatabase, bytes: Buffer, expectedHash = reviewedDdinterSha256) {
  const archives = parseReviewedDdinter(bytes, expectedHash);
  requireBaseData(db);
  return db.transaction(() => {
    initializeDdinterSupplements(db);
    const countPairs = () => (db.prepare('SELECT COUNT(*) AS count FROM ddinter_all_pairs').get() as { count: number }).count;
    const beforePairs = countPairs();
    let addedSnapshots = 0, alreadyPresent = 0, preservedExisting = 0;
    const existing = db.prepare('SELECT sha256 FROM ddinter_web_snapshots WHERE id=?');
    for (const archive of archives) {
      const prior = existing.get(archive.id) as { sha256: string } | undefined;
      // A bundled snapshot never replaces any locally acquired version or date.
      if (prior) { if (prior.sha256 === archive.sha256) alreadyPresent++; else preservedExisting++; continue; }
      importDdinterGraph(db, archive.raw, archive.id, archive.retrievedAt);
      addedSnapshots++;
    }
    const afterPairs = countPairs();
    return { addedSnapshots, alreadyPresent, preservedExisting, beforePairs, afterPairs, addedPairs: afterPairs - beforePairs };
  }).immediate();
}

export async function applyReviewedDdinterFile(filename: string, { backup = false } = {}) {
  if ((await stat(bundleUrl)).size > maxBytes) throw new Error('DDInter 補充資料過大，未補入。');
  const bytes = await readFile(bundleUrl);
  parseReviewedDdinter(bytes);
  // Do not create an empty database when the user has not installed base data.
  const db = new Database(filename, { fileMustExist: true }) as DrugDatabase;
  let backupPath: string | undefined;
  try {
    db.pragma('busy_timeout = 5000');
    requireBaseData(db);
    if (backup) {
      const directory = path.join(path.dirname(path.resolve(filename)), 'backups');
      await mkdir(directory, { recursive: true });
      backupPath = path.join(directory, `before-reviewed-ddinter-${Date.now()}-${randomUUID()}.db`);
      await db.backup(backupPath);
    }
    return { ...applyReviewedDdinter(db, bytes), backupPath, bundle: fileURLToPath(bundleUrl) };
  } finally { db.close(); }
}
