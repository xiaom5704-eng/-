import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { getTfda, type DrugDatabase } from '../medications/store';

export const ORIGINAL_TRANSFORM = 'official-reference-webp-q95-max8192-v1';
const MAX_BYTES = 50_000_000;
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
export interface OriginalReference {
  drug_id: string; source_url: string; sha256: string; source_sha256: string;
  source_width: number; source_height: number; width: number; height: number; fetched_at: string;
}

// Only the public TFDA image endpoint already linked to the exact local license.
// Do not follow redirects or let a source record request arbitrary hosts/paths.
export function allowedOriginalUrl(value: string) {
  try {
    const url = new URL(value);
    return url.origin === 'https://mcp.fda.gov.tw' && !url.username && !url.password && !url.hash &&
      /^\/insert\/shapeImg\/[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}(?:_img_[1-9]\d{0,2})?$/i.test(url.pathname) && url.search === '?c=o';
  } catch { return false; }
}

export class ReferenceOriginals {
  constructor(private drugs: DrugDatabase, readonly root: string) {}
  private current(row: Pick<OriginalReference, 'drug_id' | 'source_url'>) {
    return allowedOriginalUrl(row.source_url) && !!getTfda(this.drugs, row.drug_id)?.appearance?.imageUrls.includes(row.source_url);
  }
  private filename(sha: string) {
    return /^[a-f0-9]{64}$/.test(sha) ? path.resolve(this.root, 'images', `${sha}.webp`) : null;
  }
  private query(sql: string, args: string[]): OriginalReference[] {
    const filename = path.join(this.root, 'index.db');
    if (!existsSync(filename)) return [];
    let index: Database.Database | undefined;
    try {
      index = new Database(filename, { readonly: true, fileMustExist: true });
      return (index.prepare(`SELECT * FROM reference_originals WHERE transform=? AND ${sql}`).all(ORIGINAL_TRANSFORM, ...args) as OriginalReference[])
        .filter(row => this.current(row) && !!this.filename(row.sha256) && existsSync(this.filename(row.sha256)!));
    } catch { return []; }
    finally { index?.close(); }
  }
  forDrugs(ids: string[]) { return ids.length ? this.query(`drug_id IN (${ids.map(() => '?').join(',')})`, ids) : []; }
  fileFor(sha: string) { return this.filename(sha) && this.query('sha256=?', [sha]).length ? this.filename(sha) : null; }

  async download(drugId: string, sourceUrl: string, request: typeof fetch = fetch) {
    const source = { drug_id: drugId, source_url: sourceUrl };
    if (!this.current(source)) throw new Error('圖片必須是此許可證目前列出的 TFDA 官方原圖。');
    const response = await request(sourceUrl, { redirect: 'error', signal: AbortSignal.timeout(120_000) });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`官方原圖下載失敗：HTTP ${response.status}`); }
    if (!response.body) throw new Error('官方原圖回應沒有內容。');
    if (Number(response.headers.get('content-length')) > MAX_BYTES) { await response.body.cancel(); throw new Error('官方原圖超過 50 MB，保留既有參考圖。'); }
    const reader = response.body.getReader(), chunks: Uint8Array[] = []; let length = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > MAX_BYTES) { await reader.cancel(); throw new Error('官方原圖超過 50 MB，保留既有參考圖。'); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    const bytes = Buffer.concat(chunks);
    const input = sharp(bytes, { limitInputPixels: 80_000_000, animated: false });
    const metadata = await input.metadata();
    if (!['jpeg', 'png', 'webp'].includes(metadata.format || '') || (metadata.pages || 1) !== 1 || Math.min(metadata.width || 0, metadata.height || 0) < 32)
      throw new Error('官方來源不是可用的單張藥品圖片，保留既有參考圖。');
    const { data, info } = await input.rotate().flatten({ background: '#fff' }).toColourspace('srgb')
      .resize({ width: 8192, height: 8192, fit: 'inside', withoutEnlargement: true }).webp({ quality: 95 }).toBuffer({ resolveWithObject: true });
    const row: OriginalReference = { ...source, sha256: sha256(data), source_sha256: sha256(bytes), source_width: metadata.width!, source_height: metadata.height!,
      width: info.width, height: info.height, fetched_at: new Date().toISOString() };
    if (!this.current(source)) throw new Error('下載期間品項來源已改變，未收錄圖片。');
    const destination = this.filename(row.sha256)!;
    await mkdir(path.dirname(destination), { recursive: true });
    const temporary = `${destination}.${randomUUID()}.tmp`;
    try { await writeFile(temporary, data); await rename(temporary, destination); }
    finally { await rm(temporary, { force: true }); }
    const index = new Database(path.join(this.root, 'index.db'));
    try {
      index.pragma('journal_mode = WAL'); index.pragma('busy_timeout = 5000');
      index.exec(`CREATE TABLE IF NOT EXISTS reference_originals (
        drug_id TEXT NOT NULL, source_url TEXT NOT NULL, sha256 TEXT NOT NULL, source_sha256 TEXT NOT NULL,
        source_width INTEGER NOT NULL, source_height INTEGER NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL,
        fetched_at TEXT NOT NULL, transform TEXT NOT NULL, PRIMARY KEY(drug_id, source_url));
        CREATE INDEX IF NOT EXISTS original_hashes ON reference_originals(sha256);`);
      index.prepare('INSERT OR REPLACE INTO reference_originals VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run(drugId, sourceUrl, row.sha256, row.source_sha256, row.source_width, row.source_height, row.width, row.height, row.fetched_at, ORIGINAL_TRANSFORM);
    } finally { index.close(); }
    return row;
  }
}
