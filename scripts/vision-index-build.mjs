import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { isUnitVisionVector } from '../shared/vision-vector.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const fields = 'key,drug_id,source_url,sha256,model,embedding';
function validVector(bytes, dimensions) {
  if (!Buffer.isBuffer(bytes) || bytes.length !== dimensions * 4) return false;
  const vector = new Float32Array(Uint8Array.from(bytes).buffer);
  return isUnitVisionVector(vector, dimensions);
}

// Work is resumable, but readers see only the last completely published index.
// SQLite commits the new rows and metadata together; no database-file swap.
export class VisionIndexBuild {
  constructor(db, model, dimensions) {
    this.db = db; this.model = model; this.dimensions = dimensions;
    db.pragma('journal_mode = WAL');
    db.exec(`CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS images (key TEXT PRIMARY KEY, drug_id TEXT NOT NULL, source_url TEXT NOT NULL,
        sha256 TEXT NOT NULL, model TEXT NOT NULL, embedding BLOB NOT NULL);
      CREATE INDEX IF NOT EXISTS image_drugs ON images(drug_id);
      CREATE TABLE IF NOT EXISTS image_build_cache (cache_key TEXT PRIMARY KEY, key TEXT NOT NULL, drug_id TEXT NOT NULL,
        source_url TEXT NOT NULL, sha256 TEXT NOT NULL, model TEXT NOT NULL, embedding BLOB NOT NULL);`);
    this.baseIndex = this.currentIndex();
    this.staged = new Map();
  }
  currentIndex() { return this.db.prepare("SELECT value FROM metadata WHERE key='index'").get()?.value; }
  cacheKey(row) { return hash(JSON.stringify([this.model, this.dimensions, row.key, row.id, row.src, row.sha])); }
  reusable(row) {
    const candidate = this.db.prepare('SELECT * FROM image_build_cache WHERE cache_key=?').get(this.cacheKey(row));
    const published = this.db.prepare('SELECT * FROM images WHERE key=?').get(row.key);
    for (const item of [candidate, published]) if (item?.model === this.model && item.key === row.key && item.drug_id === row.id &&
      item.source_url === row.src && item.sha256 === row.sha && validVector(item.embedding, this.dimensions)) return item.embedding;
    return null;
  }
  stage(row, bytes) {
    if (!/^[a-f0-9]{64}$/.test(row.key) || !/^[a-f0-9]{64}$/.test(row.sha) || !row.id || !row.src || !validVector(bytes, this.dimensions))
      throw Error('圖片索引欄位或特徵格式不符，未發布。');
    const cacheKey = this.cacheKey(row);
    this.db.prepare(`INSERT OR REPLACE INTO image_build_cache (cache_key,${fields}) VALUES (?,?,?,?,?,?,?)`)
      .run(cacheKey, row.key, row.id, row.src, row.sha, this.model, bytes);
    this.staged.set(row.key, cacheKey);
  }
  publish(meta, expectedRows) {
    if (!expectedRows.length || expectedRows.length !== this.staged.size || new Set(expectedRows.map(row => row.key)).size !== expectedRows.length)
      throw Error('圖片尚未全部完成，保留原索引。');
    let result;
    this.db.transaction(() => {
      if (this.currentIndex() !== this.baseIndex) throw Error('另一個程序已更新圖片索引，請重新執行。');
      const records = expectedRows.map(row => {
        const key = this.cacheKey(row), record = this.db.prepare('SELECT * FROM image_build_cache WHERE cache_key=?').get(key);
        if (this.staged.get(row.key) !== key || !record || record.key !== row.key || record.drug_id !== row.id ||
            record.source_url !== row.src || record.sha256 !== row.sha || record.model !== this.model || !validVector(record.embedding, this.dimensions))
          throw Error('待發布圖片不完整，保留原索引。');
        return record;
      });
      this.db.prepare('DELETE FROM images').run();
      const insert = this.db.prepare(`INSERT INTO images (${fields}) VALUES (?,?,?,?,?,?)`);
      for (const row of records) insert.run(row.key, row.drug_id, row.source_url, row.sha256, row.model, row.embedding);
      result = { ...meta, state: 'ready', modelVersion: this.model, dimensions: this.dimensions,
        indexedAt: new Date().toISOString(), revision: randomUUID(), count: records.length, failed: 0,
        drugCount: new Set(records.map(row => row.drug_id)).size };
      this.db.prepare('INSERT OR REPLACE INTO metadata VALUES (?,?)').run('index', JSON.stringify(result));
      this.db.prepare('DELETE FROM image_build_cache').run();
    }).immediate();
    return result;
  }
}

// Existing valid content-addressed files are never truncated during a rebuild.
// New/repaired files appear only after the full bytes have been written.
export async function saveVerifiedImage(directory, sha, bytes) {
  if (!/^[a-f0-9]{64}$/.test(sha) || hash(bytes) !== sha) throw Error('圖片雜湊不符');
  const destination = path.join(path.resolve(directory), `${sha}.webp`);
  try { if (hash(await readFile(destination)) === sha) return; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, bytes, { flag: 'wx' }); await rename(temporary, destination); }
  finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}
