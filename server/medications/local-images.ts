import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { DrugCandidate } from '../../shared/medication';
import { getTfda, type DrugDatabase } from './store';
import { INDEX_PATH, IMAGE_ROOT } from '../vision/config.mjs';
import { ReferenceOriginals } from '../vision/reference-originals';

interface ImageRow { drug_id: string; source_url: string; sha256: string }
const validHash = (value: string) => /^[a-f0-9]{64}$/.test(value);

// Viewing an already downloaded reference image does not require inference or
// model files. Still recheck its exact license + current source URL on every use.
export class LocalMedicationImages {
  private originals: ReferenceOriginals;
  constructor(private drugs: DrugDatabase, private indexPath = INDEX_PATH, private imageRoot = IMAGE_ROOT) {
    this.originals = new ReferenceOriginals(drugs, path.join(path.dirname(indexPath), 'originals'));
  }

  private read<T>(query: (db: Database.Database, model: string) => T, fallback: T): T {
    if (!existsSync(this.indexPath)) return fallback;
    let index: Database.Database | undefined;
    try {
      index = new Database(this.indexPath, { readonly: true, fileMustExist: true });
      const row = index.prepare("SELECT value FROM metadata WHERE key='index'").get() as { value: string } | undefined;
      const metadata = JSON.parse(row?.value || '{}');
      if (metadata.state !== 'ready' || (metadata.kind || 'pill') !== 'pill' || typeof metadata.modelVersion !== 'string') return fallback;
      return query(index, metadata.modelVersion);
    } catch { return fallback; }
    finally { index?.close(); }
  }
  private file(sha: string) {
    if (!validHash(sha)) return null;
    const filename = path.resolve(this.imageRoot, `${sha}.webp`);
    return existsSync(filename) ? filename : null;
  }

  attach(drugs: DrugCandidate[]): DrugCandidate[] {
    const ids = [...new Set(drugs.filter(drug => drug.source === 'tfda' && drug.appearance?.imageUrls.length).map(drug => drug.id))];
    if (!ids.length) return drugs;
    const rows = this.read((index, model) => index.prepare(`SELECT drug_id,source_url,sha256 FROM images WHERE model=? AND drug_id IN (${ids.map(() => '?').join(',')})`).all(model, ...ids) as ImageRow[], []);
    const originals = this.originals.forDrugs(ids);
    return drugs.map(drug => {
      if (drug.source !== 'tfda' || !drug.appearance) return drug;
      const localImageUrls = Object.fromEntries(rows.filter(row => row.drug_id === drug.id && drug.appearance!.imageUrls.includes(row.source_url) && this.file(row.sha256))
        .map(row => [row.source_url, `/api/medications/reference-images/${row.sha256}.webp`]));
      const details = originals.filter(row => row.drug_id === drug.id && drug.appearance!.imageUrls.includes(row.source_url));
      const localDetailImages = Object.fromEntries(details.map(row => [row.source_url, {
        url: `/api/medications/reference-images/${row.sha256}.webp`, width: row.width, height: row.height, fetchedAt: row.fetched_at,
      }]));
      // Keep lightweight thumbnails when available; a source original also works without a CV index.
      for (const row of details) localImageUrls[row.source_url] ||= localDetailImages[row.source_url].url;
      const { localImageUrls: _previous, localDetailImages: _previousDetails, ...appearance } = drug.appearance;
      return { ...drug, appearance: { ...appearance, ...(Object.keys(localImageUrls).length ? { localImageUrls } : {}), ...(details.length ? { localDetailImages } : {}) } };
    });
  }

  fileFor(sha: string): string | null {
    const original = this.originals.fileFor(sha);
    if (original) return original;
    const file = this.file(sha);
    if (!file) return null;
    return this.read((index, model) => {
      const rows = index.prepare('SELECT drug_id,source_url,sha256 FROM images WHERE model=? AND sha256=?').all(model, sha) as ImageRow[];
      return rows.some(row => getTfda(this.drugs, row.drug_id)?.appearance?.imageUrls.includes(row.source_url)) ? file : null;
    }, null);
  }
}
