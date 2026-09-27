import Database from 'better-sqlite3';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { getTfda, normalizeName, type DrugDatabase } from '../medications/store';
import { compareImprint, eligibleForPillSearch, MIN_VISUAL_SIMILARITY, rankVisualReferences, type VisionCandidate, type VisionResult, type VisionStatus, type VisualReference } from '../../shared/medication-vision';
import { searchRevision } from '../medications/search-index';
import { MODEL_VERSION, MODEL_PATH, INDEX_PATH, IMAGE_ROOT, DIMENSIONS } from './config.mjs';
import { LocalMedicationImages } from '../medications/local-images';
import { isUnitVisionVector } from '../../shared/vision-vector.mjs';
import { pillReferenceIdentity, canCollectPillReference } from '../../shared/pill-references';
import type { PersonalPillReferences } from './personal-pills';

interface Row { key: string; drug_id: string; source_url: string; sha256: string; embedding: Buffer; product_name?: string; source_note?: string }
export interface IndexedReference extends VisualReference { sourceUrl: string; sha: string; productName?: string; sourceNote?: string; personalIdentity?: string }
export class VisionService {
  private cache: { version: string; rows: IndexedReference[] } | undefined;
  constructor(private drugs: DrugDatabase, private indexPath = INDEX_PATH, private imagesPath = IMAGE_ROOT,
    private modelPath = MODEL_PATH, private embed = async (bytes: Buffer): Promise<Float32Array> => (await import('./model.mjs')).imageEmbedding(bytes),
    private kind: 'pill' | 'package' = 'pill', private personal?: PersonalPillReferences) {}

  private matchesSource(reference: IndexedReference, drug = getTfda(this.drugs, reference.drugId)) {
    if (reference.personalIdentity) return !!drug && canCollectPillReference(drug) && pillReferenceIdentity(drug) === reference.personalIdentity;
    return this.kind === 'package' ? !!drug && normalizeName(drug.name) === normalizeName(reference.productName || '')
      : !!drug && eligibleForPillSearch(drug) && drug.appearance?.imageUrls.includes(reference.sourceUrl);
  }

  private availableReferences() {
    // File availability can change independently of the published index. Read
    // the flat directory once instead of caching missing files until a rebuild
    // or issuing thousands of individual file checks on every status request.
    try {
      const files = new Set(readdirSync(this.imagesPath, { withFileTypes: true }).filter(file => file.isFile()).map(file => file.name));
      return (this.cache?.rows || []).filter(row => files.has(`${row.sha}.webp`));
    } catch { return []; }
  }

  private officialStatus(): VisionStatus {
    const empty: VisionStatus = { ready: false, imageCount: 0, drugCount: 0, kind: this.kind, model: 'DINOv2 Small（本機圖片檢索）' };
    if (!existsSync(this.indexPath)) return { ...empty, reason: this.kind === 'package' ? '藥盒圖庫尚無參考照片，可先收錄已核對品名的藥盒，或使用 OCR 查藥名。' : '參考圖片索引尚未建立，請先使用 OCR 或手動搜尋。' };
    let db: Database.Database | undefined;
    try {
      db = new Database(this.indexPath, { readonly: true });
      const row = db.prepare("SELECT value FROM metadata WHERE key='index'").get() as { value: string } | undefined;
      const metadata = JSON.parse(row?.value || '{}');
      if ((metadata.kind || 'pill') !== this.kind) return { ...empty, reason: '圖片庫類型不符，請確認藥盒與藥錠圖庫設定。' };
      if (metadata.state !== 'ready' || metadata.modelVersion !== MODEL_VERSION) return { ...empty, reason: '圖片索引正在建立或需要更新，請先使用 OCR。' };
      if (!existsSync(path.join(this.modelPath, 'onnx/model_quantized.onnx'))) return { ...empty, reason: '本機視覺模型尚未備妥，請先使用 OCR。' };
      const version = `${metadata.indexedAt}:${metadata.modelVersion}:${metadata.revision || ''}:${searchRevision(this.drugs)}`;
      if (this.cache?.version !== version) {
        const rows = db.prepare(`SELECT key,drug_id,source_url,sha256,embedding${this.kind === 'package' ? ',product_name,source_note' : ''} FROM images WHERE model=?`).all(MODEL_VERSION) as Row[];
        const usable = rows.filter(row => {
          if (!/^[a-f0-9]{64}$/.test(row.sha256) || row.embedding.length !== DIMENSIONS * 4) return false;
          const drug = getTfda(this.drugs, row.drug_id);
          return this.kind === 'package' ? !!row.product_name && !!drug && normalizeName(drug.name) === normalizeName(row.product_name)
            : !!drug && eligibleForPillSearch(drug) && drug.appearance?.imageUrls.includes(row.source_url);
        }).map(row => ({ key: row.key, drugId: row.drug_id, sourceUrl: row.source_url, sha: row.sha256,
          productName: row.product_name, sourceNote: row.source_note, vector: new Float32Array(Uint8Array.from(row.embedding).buffer) }));
        this.cache = { version, rows: usable.filter(row => isUnitVisionVector(row.vector, DIMENSIONS)) };
      }
      const available = this.availableReferences();
      return { ...empty, ready: !!available.length, imageCount: this.kind === 'package' ? new Set(available.map(row => row.sha)).size : available.length,
        ...(this.kind === 'package' ? { productCount: new Set(available.map(row => row.productName)).size } : {}),
        drugCount: new Set(available.map(row => row.drugId)).size, indexedAt: metadata.indexedAt, sourceVersion: metadata.sourceVersion,
        ...(!available.length ? { reason: '沒有可用的本機參考圖，請還原圖片或重新建立索引。' } : {}) };
    } catch { return { ...empty, reason: '圖片索引無法讀取，請重新建立索引或使用 OCR。' }; }
    finally { db?.close(); }
  }

  status(): VisionStatus {
    const official = this.officialStatus();
    // Never reuse rows from an old index when its current validation fails.
    if (!official.ready) this.cache = undefined;
    if (!this.personal || this.kind !== 'pill') return official;
    const { references, library } = this.personal.snapshot();
    const modelReady = existsSync(path.join(this.modelPath, 'onnx/model_quantized.onnx'));
    const personal = modelReady ? references : [];
    const available = [...this.availableReferences(), ...personal];
    return { ...official, ready: !!available.length, imageCount: available.length,
      drugCount: new Set(available.map(row => row.drugId)).size, personalImageCount: personal.length,
      reason: available.length ? undefined : official.reason,
      sourceVersion: [official.sourceVersion, ...(personal.length ? ['使用者核對的本機藥錠照片'] : [])].filter(Boolean).join('；'),
      personalWarning: [library.warning, ...(!official.ready && personal.length ? [official.reason] : [])].filter(Boolean).join('；') || undefined };
  }

  imagePath(sha: string): string | null {
    if (!this.status().ready) return null;
    if (!/^[a-f0-9]{64}$/.test(sha) || !this.availableReferences().some(row => row.sha === sha)) return null;
    const file = path.join(this.imagesPath, `${sha}.webp`);
    return existsSync(file) ? file : null;
  }

  async search(images: Buffer[], imprint: string, signal: AbortSignal): Promise<VisionResult> {
    signal.throwIfAborted();
    const initial = this.status();
    if (!initial.ready) throw new Error(initial.reason || '圖片比對尚未就緒。');
    const vectors = [];
    for (const bytes of images) {
      signal.throwIfAborted();
      const vector = await this.embed(bytes);
      if (!isUnitVisionVector(vector, DIMENSIONS)) throw new Error('影像特徵格式無效，請重新比對。');
      vectors.push(vector);
    }
    signal.throwIfAborted();
    const status = this.status();
    if (!status.ready) throw new Error(status.reason || '圖片比對尚未就緒。');
    const references = [...this.availableReferences(), ...(this.kind === 'pill' ? this.personal?.snapshot().references || [] : [])];
    // Exact imprints search the entire appearance database, including products
    // without a usable reference vector. They are independent retrieval evidence.
    const imprintDrugs = this.kind === 'pill' && imprint.trim() ?
      (this.drugs.prepare("SELECT id FROM tfda_appearance_terms WHERE kind='imprint' AND value=? ORDER BY id")
        .all(normalizeName(imprint).replace(/\s/g, '')) as { id: string }[])
        .map(row => getTfda(this.drugs, row.id)).filter(drug => drug && eligibleForPillSearch(drug) && compareImprint(imprint, drug.appearance) === 'match') : [];
    const exactIds = new Set(imprintDrugs.map(drug => drug!.id));
    const threshold = this.kind === 'package' ? 0.75 : MIN_VISUAL_SIMILARITY;
    const ranked = rankVisualReferences(vectors, references, references.length, exactIds.size ? -1 : threshold);
    const byKey = new Map(references.map(row => [row.key, row]));
    const matches: VisionCandidate[] = [];
    for (const match of ranked) {
      const imageMatched = match.views.every(view => view.similarity >= threshold);
      if (!imageMatched && !exactIds.has(match.drugId)) continue;
      // Re-read canonical drug data: never accept ingredient/identity claims from a photo.
      const drug = getTfda(this.drugs, match.drugId);
      if (!drug) continue;
      const imageRows = [...new Set(match.views.map(view => view.key))].map(key => byKey.get(key)!);
      if (imageRows.some(row => !this.matchesSource(row, drug))) continue;
      const imprintMatched = exactIds.has(drug.id);
      matches.push({ drug, similarity: match.similarity, matchedBy: imageMatched ? imprintMatched ? 'image_and_imprint' : 'image' : 'imprint',
        imprint: this.kind === 'package' ? 'not_given' : compareImprint(imprint, drug.appearance),
        images: imageRows.map(row => ({ url: `/api/medications/${this.kind === 'package' ? 'packages' : 'vision'}/${row.personalIdentity ? 'personal-images' : 'images'}/${row.sha}.webp`, sourceUrl: row.sourceUrl,
          ...(row.personalIdentity ? { provenance: 'personal' as const } : {}), ...(row.sourceNote ? { sourceNote: row.sourceNote } : {}) })) });
      if (!imprint.trim() && matches.length === 8) break;
    }
    const included = new Set(matches.map(match => match.drug.id));
    for (const drug of imprintDrugs) if (drug && !included.has(drug.id))
      matches.push({ drug, similarity: null, matchedBy: 'imprint', imprint: 'match', images: [] });
    const candidates = matches.sort((a, b) => Number(b.imprint === 'match') - Number(a.imprint === 'match') ||
      Number(b.matchedBy !== 'imprint') - Number(a.matchedBy !== 'imprint') || (b.similarity ?? -Infinity) - (a.similarity ?? -Infinity) || a.drug.id.localeCompare(b.drug.id)).slice(0, 8);
    if (this.kind === 'pill') {
      const localDrugs = new LocalMedicationImages(this.drugs, this.indexPath, this.imagesPath).attach(candidates.map(candidate => candidate.drug));
      candidates.forEach((candidate, i) => { candidate.drug = localDrugs[i]; });
    }
    if (this.kind === 'package') return { status, candidates, outcome: candidates.length ? 'review' : 'low_similarity', warnings: [
      '這是本機藥盒參考圖的相似候選，相似度不是辨識正確率。請核對完整品名、規格、許可證與實際包裝。',
      '藥盒照片依收錄時填寫的品名連結資料；同名的不同許可證會全部保留，照片本身不能確認許可證或成分。',
      '只比對已收錄的包裝。改版、不同規格與相似配色可能造成漏查或誤配；不會自動辨認未收錄的藥盒。',
      ...(images.length === 2 ? ['請只上傳同一品項的兩個包裝視角，勿混入藥錠或其他藥盒。'] : []),
    ] };
    const warnings = ['候選依照片相似或您填寫的完整刻字找到，尚未確認藥品身分；相似度不是辨識正確率。',
      '圖片比對只涵蓋可用的本機參考圖；刻字另查本機外觀資料，不受圖片門檻限制。沒有候選不代表藥品不存在。',
      '藥錠比對排除來源已標示為針劑、液劑、藥膏等製劑；這些品項仍可用藥名搜尋與查看圖片。外觀不能決定用法或給藥途徑。'];
    if (status.personalImageCount) warnings.push('本次圖庫包含使用者核對後自行收錄的照片，非官方照片；相似候選仍需對照許可證、藥袋與實物。');
    if (status.personalWarning) warnings.push(status.personalWarning);
    if (images.length === 2) warnings.push('兩張照片以同一種藥的不同面合併比對，請勿混入不同藥品。');
    const visual = candidates.filter(candidate => candidate.matchedBy !== 'imprint');
    if (visual.length > 1 && Math.abs(visual[0].similarity! - visual[1].similarity!) < 0.04) warnings.push('多個品項外觀接近，請補充刻字、藥袋或請藥師核對。');
    if (exactIds.size > 1) warnings.push(`同一刻字符合 ${exactIds.size} 個藥錠品項，刻字本身不能唯一確認藥品，請繼續核對正反面、顏色與規格。`);
    if (imprint.trim() && !candidates.some(candidate => candidate.imprint === 'match')) warnings.push('沒有候選與輸入刻字完全相符，請核對 0／O、1／I 及另一面的刻字。');
    return { status, candidates, warnings, outcome: candidates.length ? 'review' : 'low_similarity',
      ...(imprint.trim() ? { imprintSearch: { input: imprint.trim(), total: exactIds.size, shown: candidates.filter(candidate => candidate.imprint === 'match').length } } : {}) };
  }
}
