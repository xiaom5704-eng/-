import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { getTfda, type DrugDatabase } from '../medications/store';
import { canCollectPillReference, pillReferenceIdentity, type PersonalPillLibrary } from '../../shared/pill-references';
import { isUnitVisionVector } from '../../shared/vision-vector.mjs';
import { DIMENSIONS, MODEL_VERSION, VISION_ROOT } from './config.mjs';
import type { IndexedReference } from './service';

interface Row {
  key: string; drug_id: string; identity: string; product_name: string; sha256: string;
  source_note: string; model: string; embedding: Buffer; created_at: string; disabled: number;
}
const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const photoUrl = (sha: string) => `/api/medications/vision/personal-images/${sha}.webp`;

export class PersonalPillReferences {
  private verifiedFiles = new Map<string, { version: string; valid: boolean }>();
  private indexPath: string;
  private imageRoot: string;
  constructor(private drugs: DrugDatabase, root = path.join(VISION_ROOT, 'personal-pills'),
    private embed = async (bytes: Buffer): Promise<Float32Array> => (await import('./model.mjs')).imageEmbedding(bytes)) {
    this.indexPath = path.join(root, 'index.db'); this.imageRoot = path.join(root, 'images');
  }

  private validImage(sha: string): boolean {
    if (!/^[a-f0-9]{64}$/.test(sha)) return false;
    try {
      const file = path.join(this.imageRoot, `${sha}.webp`), info = statSync(file);
      if (!info.isFile() || !info.size || info.size > 8 * 1024 * 1024) return false;
      const version = `${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
      let cached = this.verifiedFiles.get(sha);
      if (cached?.version !== version) {
        cached = { version, valid: hash(readFileSync(file)) === sha }; this.verifiedFiles.set(sha, cached);
      }
      return cached.valid;
    } catch { return false; }
  }

  private rows(): Row[] {
    if (!existsSync(this.indexPath)) return [];
    const db = new Database(this.indexPath, { readonly: true });
    try { return db.prepare('SELECT * FROM personal_pill_images ORDER BY created_at DESC, key').all() as Row[]; }
    finally { db.close(); }
  }

  private reason(row: Row): string | undefined {
    if (row.disabled) return '已停用，不參與比對';
    const drug = getTfda(this.drugs, row.drug_id);
    if (!drug || !canCollectPillReference(drug) || pillReferenceIdentity(drug) !== row.identity) return '品項資料已變動或缺失，請重新核對後收錄';
    if (row.model !== MODEL_VERSION) return '模型版本已變動，請重新收錄';
    if (!Buffer.isBuffer(row.embedding) || row.embedding.length !== DIMENSIONS * 4 || !isUnitVisionVector(new Float32Array(Uint8Array.from(row.embedding).buffer), DIMENSIONS)) return '圖片特徵已損毀，請重新收錄';
    if (!this.validImage(row.sha256)) return '照片缺失或損毀，請重新收錄';
  }

  snapshot(): { library: PersonalPillLibrary; references: IndexedReference[] } {
    try {
      const references: IndexedReference[] = [];
      const photos = this.rows().map(row => {
        const reason = this.reason(row);
        if (!reason) references.push({ key: `personal:${row.key}`, drugId: row.drug_id,
          vector: new Float32Array(Uint8Array.from(row.embedding).buffer), sha: row.sha256,
          sourceUrl: '', sourceNote: row.source_note, personalIdentity: row.identity });
        return { key: row.key, drugId: row.drug_id, name: row.product_name, sourceNote: row.source_note,
          createdAt: row.created_at, usable: !reason, disabled: !!row.disabled, ...(reason ? { reason } : { imageUrl: photoUrl(row.sha256) }) };
      });
      return { references, library: { photos } };
    } catch { return { references: [], library: { photos: [], warning: '自存藥錠圖庫無法讀取；本次只使用可用的官方參考圖。' } }; }
  }

  imagePath(sha: string): string | null {
    if (!/^[a-f0-9]{64}$/.test(sha) || !this.snapshot().references.some(row => row.sha === sha)) return null;
    return path.join(this.imageRoot, `${sha}.webp`);
  }

  disable(key: string): void {
    if (!/^[a-f0-9]{64}$/.test(key) || !existsSync(this.indexPath)) throw new Error('找不到這筆收錄照片。');
    const db = new Database(this.indexPath);
    try {
      if (!db.prepare('UPDATE personal_pill_images SET disabled=1 WHERE key=?').run(key).changes) throw new Error('找不到這筆收錄照片。');
    } finally { db.close(); }
  }

  async register(images: Buffer[], drugId: string, identity: string, sourceNote: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const note = sourceNote.trim();
    if (!note || note.length > 300 || images.length < 1 || images.length > 2 || images.reduce((n, bytes) => n + bytes.length, 0) > 12 * 1024 * 1024) throw new Error('請提供照片來源與同一品項的 1–2 張照片，合計上限 12 MB。');
    const canonical = () => {
      const drug = getTfda(this.drugs, drugId);
      if (!drug || !canCollectPillReference(drug)) throw new Error('請先搜尋並確認有成分資料的臺灣藥錠、膠囊或丸劑品項。');
      if (pillReferenceIdentity(drug) !== identity) throw new Error('品項資料已更新，請重新搜尋並核對許可證、成分與規格後收錄。');
      return drug;
    };
    canonical();
    const references = [];
    for (const input of images) {
      signal.throwIfAborted();
      if (!input.length || input.length > 8 * 1024 * 1024) throw new Error('單張照片上限 8 MB。');
      const photo = sharp(input, { limitInputPixels: 24_000_000, animated: false });
      const metadata = await photo.metadata();
      if (!['jpeg', 'png', 'webp'].includes(metadata.format || '') || (metadata.pages || 1) !== 1 || Math.min(metadata.width || 0, metadata.height || 0) < 32) throw new Error('請提供清楚的單張 JPEG、PNG 或 WebP 藥錠照片。');
      const bytes = await photo.rotate().flatten({ background: '#fff' }).resize(1600, 1600, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 92 }).toBuffer();
      if (bytes.length > 8 * 1024 * 1024) throw new Error('轉換後照片過大，請裁切後再收錄。');
      const vector = await this.embed(bytes);
      if (!isUnitVisionVector(vector, DIMENSIONS)) throw new Error('影像特徵格式無效，未收錄照片。');
      references.push({ bytes, vector, sha: hash(bytes) });
    }
    signal.throwIfAborted(); canonical();
    await mkdir(this.imageRoot, { recursive: true });
    for (const row of references) {
      if (this.validImage(row.sha)) continue;
      const temporary = path.join(this.imageRoot, `.${row.sha}-${randomUUID()}.tmp`);
      try {
        await writeFile(temporary, row.bytes, { flag: 'wx' });
        signal.throwIfAborted();
        await rename(temporary, path.join(this.imageRoot, `${row.sha}.webp`));
      } finally { await rm(temporary, { force: true }); }
    }
    signal.throwIfAborted();
    const drug = canonical();
    const db = new Database(this.indexPath);
    try {
      db.pragma('journal_mode = WAL');
      db.exec(`CREATE TABLE IF NOT EXISTS personal_pill_images (key TEXT PRIMARY KEY, drug_id TEXT NOT NULL,
        identity TEXT NOT NULL, product_name TEXT NOT NULL, sha256 TEXT NOT NULL, source_note TEXT NOT NULL,
        model TEXT NOT NULL, embedding BLOB NOT NULL, created_at TEXT NOT NULL, disabled INTEGER NOT NULL DEFAULT 0)`);
      db.transaction(() => {
        const insert = db.prepare('INSERT OR REPLACE INTO personal_pill_images VALUES (?,?,?,?,?,?,?,?,?,0)');
        for (const row of references) insert.run(hash(`${row.sha}\0${drug.id}`), drug.id, identity, drug.name,
          row.sha, note, MODEL_VERSION, Buffer.from(row.vector.buffer, row.vector.byteOffset, row.vector.byteLength), new Date().toISOString());
      })();
    } finally { db.close(); }
  }
}
