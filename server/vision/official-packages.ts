import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { packagePages } from './package-pages';
import { getTfda, type DrugDatabase } from '../medications/store';
import { readTfdaLabelIndex } from '../medications/tfda-label-index';
import { validTfdaLabelUrl } from '../../shared/tfda-label-index';
import { officialPackageIdentity, type OfficialPackageLibrary } from '../../shared/official-packages';
import { isUnitVisionVector } from '../../shared/vision-vector.mjs';
import { DIMENSIONS, MODEL_VERSION, VISION_ROOT } from './config.mjs';
import { downloadBounded } from '../../scripts/verified-download.mjs';
import type { IndexedReference } from './service';
import type { ReviewedPackage } from './package-starter';

const hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const photoUrl = (sha: string) => `/api/medications/packages/official-images/${sha}.webp`;
interface Row {
  key: string; drug_id: string; identity: string; product_name: string; source_url: string;
  sha256: string; source_sha256: string; retrieved_at: string; index_retrieved_at: string; index_sha256: string;
  model: string; embedding: Buffer; disabled: number;
  page: number; page_count: number;
}

export class OfficialPackageReferences {
  private indexPath: string;
  private imageRoot: string;
  private verified = new Map<string, { version: string; valid: boolean }>();
  constructor(private drugs: DrugDatabase, root = path.join(VISION_ROOT, 'official-packages'),
    private embed = async (bytes: Buffer): Promise<Float32Array> => (await import('./model.mjs')).imageEmbedding(bytes),
    private request: typeof fetch = fetch) {
    this.indexPath = path.join(root, 'index.db'); this.imageRoot = path.join(root, 'images');
  }

  matches(reference: Pick<IndexedReference, 'drugId' | 'sourceUrl' | 'officialPackageIdentity'>): boolean {
    const drug = getTfda(this.drugs, reference.drugId);
    return !!drug && officialPackageIdentity(drug) === reference.officialPackageIdentity &&
      validTfdaLabelUrl(reference.sourceUrl, drug.id, 'package') && !!readTfdaLabelIndex(this.drugs, drug)?.packageUrls.includes(reference.sourceUrl);
  }

  private validImage(sha: string) {
    if (!/^[a-f0-9]{64}$/.test(sha)) return false;
    try {
      const file = path.join(this.imageRoot, `${sha}.webp`), info = statSync(file);
      if (!info.isFile() || !info.size || info.size > 8 * 1024 * 1024) return false;
      const version = `${info.size}:${info.mtimeMs}:${info.ctimeMs}`, previous = this.verified.get(sha);
      if (previous?.version === version) return previous.valid;
      const valid = hash(readFileSync(file)) === sha; this.verified.set(sha, { version, valid }); return valid;
    } catch { return false; }
  }

  private rows(drugId?: string): Row[] {
    if (!existsSync(this.indexPath)) return [];
    const db = new Database(this.indexPath, { readonly: true });
    try { return db.prepare(`SELECT * FROM official_package_images ${drugId ? 'WHERE drug_id=?' : ''} ORDER BY drug_id,source_url,page`).all(...(drugId ? [drugId] : [])) as Row[]; }
    finally { db.close(); }
  }

  snapshot(drugId?: string): { library: OfficialPackageLibrary; references: IndexedReference[] } {
    try {
      const references: IndexedReference[] = [];
      const photos = this.rows(drugId).map(row => {
        const reference = { key: `tfda-package:${row.key}`, drugId: row.drug_id, sourceUrl: row.source_url,
          sha: row.sha256, productName: row.product_name, officialPackageIdentity: row.identity,
          vector: Buffer.isBuffer(row.embedding) && row.embedding.length === DIMENSIONS * 4 ? new Float32Array(Uint8Array.from(row.embedding).buffer) : new Float32Array(),
          sourceNote: `TFDA 外盒／標籤來源第 ${row.page}/${row.page_count} 頁；取得 ${row.retrieved_at.slice(0, 10)}，索引取得 ${row.index_retrieved_at.slice(0, 10)}。可能包含平面標籤或舊版包裝，仍需核對實物。` };
        const invalid = !this.matches(reference) ? '品項或官方連結已變動，請重新查詢'
          : row.model !== MODEL_VERSION || !isUnitVisionVector(reference.vector, DIMENSIONS) ? '圖片特徵需要重建'
          : !this.validImage(row.sha256) ? '圖片缺失或損毀，請重新保存' : undefined;
        const reason = invalid || (row.disabled === 2 ? '待核對，尚未加入照片比對' : row.disabled ? '已停用比對' : undefined);
        if (!reason) references.push(reference);
        return { key: row.key, drugId: row.drug_id, sourceUrl: row.source_url, retrievedAt: row.retrieved_at,
          indexRetrievedAt: row.index_retrieved_at, sourceSha256: row.source_sha256,
          page: row.page, pageCount: row.page_count,
          usable: !reason, disabled: row.disabled === 1, pending: row.disabled === 2,
          ...(!invalid ? { imageUrl: photoUrl(row.sha256) } : {}), ...(reason ? { reason } : {}) };
      });
      return { references, library: { photos } };
    } catch { return { references: [], library: { photos: [], warning: '官方外盒本機圖庫無法讀取；其餘可用的藥盒照片仍可比對。' } }; }
  }

  imagePath(sha: string) {
    return /^[a-f0-9]{64}$/.test(sha) && this.snapshot().library.photos.some(row => row.imageUrl === photoUrl(sha)) ? path.join(this.imageRoot, `${sha}.webp`) : null;
  }

  enable(key: string) {
    const photo = this.snapshot().library.photos.find(row => row.key === key);
    if (!photo?.imageUrl) throw new Error('外盒圖或品項已失效，請重新查詢後保存。');
    const db = new Database(this.indexPath);
    try { db.prepare('UPDATE official_package_images SET disabled=0 WHERE key=?').run(key); }
    finally { db.close(); }
  }

  disable(key: string) {
    if (!/^[a-f0-9]{64}$/.test(key) || !existsSync(this.indexPath)) throw new Error('找不到已保存的外盒圖');
    const db = new Database(this.indexPath);
    try { if (!db.prepare('UPDATE official_package_images SET disabled=1 WHERE key=?').run(key).changes) throw new Error('找不到已保存的外盒圖'); }
    finally { db.close(); }
  }

  async saveReviewed(review: ReviewedPackage, signal: AbortSignal) {
    const drug = getTfda(this.drugs, review.drugId), index = drug && readTfdaLabelIndex(this.drugs, drug);
    return this.save(review.drugId, review.sourceUrl, index?.sha256 || '', signal, review);
  }

  async save(drugId: string, sourceUrl: string, expectedIndexSha: string, signal: AbortSignal, review?: ReviewedPackage) {
    signal.throwIfAborted();
    if (review && (!/^[a-f0-9]{64}$/.test(review.sourceSha256) || !Number.isInteger(review.pageCount) || review.pageCount < 1 || review.pageCount > 8 ||
        !review.reviewedPages.length || review.reviewedPages.some(page => !Number.isInteger(page) || page < 1 || page > review.pageCount)))
      throw new Error('示範外盒核對設定無效，未保存。');
    const canonical = () => {
      const drug = getTfda(this.drugs, drugId), index = drug && readTfdaLabelIndex(this.drugs, drug);
      if (!drug || !index || index.sha256 !== expectedIndexSha || !validTfdaLabelUrl(sourceUrl, drugId, 'package') || !index.packageUrls.includes(sourceUrl))
        throw new Error('官方外盒來源或品項已變動，請重新分析後再保存。');
      const identity = officialPackageIdentity(drug);
      if (review && hash(identity) !== review.identitySha256) throw new Error('示範外盒的品項資料已變動，需要重新核對。');
      return { drug, index, identity };
    };
    const original = canonical(), saved = this.snapshot(drugId).library.photos.filter(row => row.sourceUrl === sourceUrl);
    if (review && saved.some(row => row.sourceSha256 !== review.sourceSha256 || row.pageCount !== review.pageCount))
      throw new Error('本機外盒與已核對的示範版本不同，保留現有圖片，請從官方外盒清單核對。');
    if (saved.length && saved.every(row => row.imageUrl && row.pageCount === saved.length) && new Set(saved.map(row => row.page)).size === saved.length &&
        saved.every(row => row.page >= 1 && row.page <= saved.length)) return { reused: true };
    // Only a currently linked official image; no redirects or arbitrary URL proxy.
    const bytes = await downloadBounded(sourceUrl, 8 * 1024 * 1024, (url, init) => this.request(url, {
      ...init, redirect: 'error', signal: AbortSignal.any([signal, init!.signal!]),
    }), 30_000);
    signal.throwIfAborted();
    if (review && hash(bytes) !== review.sourceSha256) throw new Error('官方外盒內容已變更，未加入示範比對，請重新核對來源。');
    const retrievedAt = new Date().toISOString(), images = await packagePages(bytes, signal), references = [];
    if (review && images.length !== review.pageCount) throw new Error('官方外盒頁數與核對紀錄不同，未保存。');
    for (const [i, image] of images.entries()) {
      if (!image.length || image.length > 8 * 1024 * 1024) throw new Error('轉換後圖片大小超過限制，未保存。');
      signal.throwIfAborted(); const vector = await this.embed(image);
      if (!isUnitVisionVector(vector, DIMENSIONS)) throw new Error('影像特徵格式無效，未保存。');
      references.push({ image, vector, sha: hash(image), page: i + 1 });
    }
    signal.throwIfAborted();
    if (canonical().identity !== original.identity) throw new Error('處理期間品項已變動，未保存。');
    await mkdir(this.imageRoot, { recursive: true });
    for (const { image, sha } of references) if (!this.validImage(sha)) {
      const temporary = path.join(this.imageRoot, `.${randomUUID()}.tmp`);
      try { await writeFile(temporary, image, { flag: 'wx' }); signal.throwIfAborted(); await rename(temporary, path.join(this.imageRoot, `${sha}.webp`)); }
      finally { await rm(temporary, { force: true }); }
    }
    signal.throwIfAborted();
    if (canonical().identity !== original.identity) throw new Error('保存期間品項已變動，未收錄。');
    const db = new Database(this.indexPath);
    try {
      db.pragma('journal_mode = WAL'); db.pragma('busy_timeout = 5000');
      db.exec(`CREATE TABLE IF NOT EXISTS official_package_images (key TEXT PRIMARY KEY, drug_id TEXT NOT NULL,
        identity TEXT NOT NULL, product_name TEXT NOT NULL, source_url TEXT NOT NULL, sha256 TEXT NOT NULL,
        source_sha256 TEXT NOT NULL, retrieved_at TEXT NOT NULL, index_retrieved_at TEXT NOT NULL, index_sha256 TEXT NOT NULL,
        model TEXT NOT NULL, embedding BLOB NOT NULL, disabled INTEGER NOT NULL DEFAULT 2, page INTEGER NOT NULL, page_count INTEGER NOT NULL)`);
      db.transaction(() => {
        const previousPages = db.prepare('SELECT page, disabled FROM official_package_images WHERE drug_id=? AND source_url=?').all(drugId, sourceUrl) as { page: number; disabled: number }[];
        db.prepare('DELETE FROM official_package_images WHERE drug_id=? AND source_url=?').run(drugId, sourceUrl);
        // Ordinary downloads remain pending. Only pinned, reviewed starter pages
        // may start enabled; repairs preserve existing user review/disable choices.
        const insert = db.prepare('INSERT INTO official_package_images VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
        for (const { vector, sha, page } of references) {
          const previous = previousPages.find(row => row.page === page);
          let disabled = 2;
          if (review) disabled = previous?.disabled ?? (review.reviewedPages.includes(page) ? 0 : 2);
          insert.run(hash(`${drugId}\0${sourceUrl}\0${page}`), drugId, original.identity,
          original.drug.name, sourceUrl, sha, hash(bytes), retrievedAt, original.index.retrievedAt, original.index.sha256,
          MODEL_VERSION, Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength), disabled, page, references.length);
        }
      })();
    } finally { db.close(); }
    return { reused: false };
  }
}
