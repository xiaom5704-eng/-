import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { normalizeName, type DrugDatabase } from '../medications/store';
import { VisionService } from './service';
import { PACKAGE_INDEX_PATH, PACKAGE_IMAGE_ROOT, MODEL_PATH, MODEL_VERSION, DIMENSIONS } from './config.mjs';
import { isUnitVisionVector } from '../../shared/vision-vector.mjs';
import type { OfficialPackageReferences } from './official-packages';

export class PackageVisionService extends VisionService {
  readonly register: (images: Buffer[], productName: string, sourceNote: string, signal: AbortSignal) => Promise<{ status: ReturnType<VisionService['status']>; productName: string; licenseCount: number }>;

  constructor(drugs: DrugDatabase, indexPath = PACKAGE_INDEX_PATH, imageRoot = PACKAGE_IMAGE_ROOT, modelRoot = MODEL_PATH,
    embed = async (bytes: Buffer): Promise<Float32Array> => (await import('./model.mjs')).imageEmbedding(bytes), officialPackages?: OfficialPackageReferences) {
    super(drugs, indexPath, imageRoot, modelRoot, embed, 'package', undefined, officialPackages);
    this.register = async (images, productName, sourceNote, signal) => {
      signal.throwIfAborted();
      const name = productName.trim(), note = sourceNote.trim();
      if (name.length < 2 || name.length > 120 || !note || note.length > 300 || images.length < 1 || images.length > 2) throw new Error('請提供完整藥名、照片來源與同一藥盒的 1–2 張照片。');
      // Link all exact-name licenses. A package front alone cannot disambiguate them.
      const matches = (drugs.prepare('SELECT id,name FROM tfda_drugs').all() as { id: string; name: string }[])
        .filter(drug => normalizeName(drug.name) === normalizeName(name));
      if (!matches.length) throw new Error('本機資料沒有完全相同的品名，請先搜尋並核對完整品名，再收錄照片。');
      const references = [];
      for (const input of images) {
        signal.throwIfAborted();
        if (input.length > 8 * 1024 * 1024) throw new Error('單張照片上限 8 MB。');
        const photo = sharp(input, { limitInputPixels: 24_000_000, animated: false });
        const metadata = await photo.metadata();
        if (!['jpeg', 'png', 'webp'].includes(metadata.format || '') || (metadata.pages || 1) !== 1 || Math.min(metadata.width || 0, metadata.height || 0) < 32) throw new Error('請提供清楚的單張 JPEG、PNG 或 WebP 藥盒照片。');
        const bytes = await photo.rotate().flatten({ background: '#fff' }).resize(1600, 1600, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 92 }).toBuffer();
        const vector = await embed(bytes);
        if (!isUnitVisionVector(vector, DIMENSIONS)) throw new Error('影像特徵格式無效，未收錄照片。');
        references.push({ bytes, vector, sha: createHash('sha256').update(bytes).digest('hex') });
      }
      signal.throwIfAborted();
      await mkdir(imageRoot, { recursive: true });
      for (const row of references) await writeFile(path.join(imageRoot, `${row.sha}.webp`), row.bytes);
      signal.throwIfAborted();
      await mkdir(path.dirname(indexPath), { recursive: true });
      const index = new Database(indexPath);
      try {
        index.pragma('journal_mode = WAL');
        index.exec(`CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS images (key TEXT PRIMARY KEY, drug_id TEXT NOT NULL, source_url TEXT NOT NULL,
          sha256 TEXT NOT NULL, model TEXT NOT NULL, embedding BLOB NOT NULL, product_name TEXT NOT NULL, source_note TEXT NOT NULL);`);
        const current = index.prepare("SELECT value FROM metadata WHERE key='index'").get() as { value: string } | undefined;
        if (current && JSON.parse(current.value).kind !== 'package') throw new Error('資料庫類型不符，未修改既有索引。');
        index.transaction(() => {
          const insert = index.prepare('INSERT OR REPLACE INTO images VALUES (?,?,?,?,?,?,?,?)');
          for (const row of references) for (const drug of matches) {
            const key = createHash('sha256').update(`${row.sha}\0${drug.id}`).digest('hex');
            insert.run(key, drug.id, '', row.sha, MODEL_VERSION, Buffer.from(row.vector.buffer, row.vector.byteOffset, row.vector.byteLength), drug.name, note);
          }
          index.prepare('INSERT OR REPLACE INTO metadata VALUES (?,?)').run('index', JSON.stringify({ state: 'ready', kind: 'package', modelVersion: MODEL_VERSION,
            indexedAt: new Date().toISOString(), revision: randomUUID(), sourceVersion: '本機收錄的藥盒照片（依品名連結候選）' }));
        })();
      } finally { index.close(); }
      return { status: this.status(), productName: matches[0].name, licenseCount: matches.length };
    };
  }
}
