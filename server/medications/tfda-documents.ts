import { Router } from 'express';
import { createHash } from 'node:crypto';
import type { DrugCandidate, MedicationReport } from '../../shared/medication';
import { isDirectTfdaPdf, type TfdaLabelDocument } from '../../shared/tfda-label-index';
import { localTfdaDocumentPath } from '../../shared/source-document';
import { downloadBounded } from '../../scripts/verified-download.mjs';
import { getTfda, type DrugDatabase } from './store';
import { readTfdaLabelIndex } from './tfda-label-index';

const hash = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');
const maxBytes = 5_000_000;
const identity = (drug: DrugCandidate) => ({ id: drug.id, name: drug.name, englishName: drug.englishName,
  ingredients: drug.ingredients, dosageForm: drug.dosageForm });
interface Metadata {
  product: ReturnType<typeof identity>; sourceUrl: string; indexSha256: string; indexRetrievedAt: string;
  sha256: string; retrievedAt: string; byteLength: number; pageCount: number;
}
interface Row { id: string; drug_id: string; source_url: string; metadata: string; pdf: Buffer }
export interface TfdaDocumentRequest { licenseId: string; sourceUrl: string; indexSha256: string; refresh?: boolean }

export function initializeTfdaDocuments(db: DrugDatabase) {
  db.exec(`CREATE TABLE IF NOT EXISTS tfda_documents (id TEXT PRIMARY KEY, drug_id TEXT NOT NULL, source_url TEXT NOT NULL, metadata TEXT NOT NULL, pdf BLOB NOT NULL);
    CREATE INDEX IF NOT EXISTS tfda_documents_product ON tfda_documents(drug_id,source_url);
    CREATE TABLE IF NOT EXISTS tfda_document_heads (drug_id TEXT NOT NULL, source_url TEXT NOT NULL, document_id TEXT NOT NULL, PRIMARY KEY(drug_id,source_url));`);
}

// Parse the bounded PDF locally. This establishes a readable document structure,
// not clinical review or agreement between the PDF text and the product label.
async function validatePdf(bytes: Buffer, signal: AbortSignal) {
  if (bytes.subarray(0, 5).toString() !== '%PDF-' || !bytes.subarray(-1024).toString().includes('%%EOF')) throw Error('來源沒有回傳完整 PDF，請開啟官方入口核對。');
  signal.throwIfAborted();
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  signal.throwIfAborted();
  const task = getDocument({ data: Uint8Array.from(bytes), isEvalSupported: false, enableXfa: false, stopAtErrors: true, verbosity: 0 });
  const abort = () => { void task.destroy().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    const pdf = await task.promise;
    if (!pdf.numPages || pdf.numPages > 50) throw Error('PDF 超過本機閱讀器的 50 頁上限，請開啟官方入口查看。');
    for (let n = 1; n <= pdf.numPages; n++) {
      signal.throwIfAborted();
      const page = await pdf.getPage(n), viewport = page.getViewport({ scale: 1 });
      if (![viewport.width, viewport.height].every(size => Number.isFinite(size) && size > 0)) throw Error('PDF 頁面尺寸無效。');
      page.cleanup();
    }
    signal.throwIfAborted(); return pdf.numPages;
  } catch (error) {
    signal.throwIfAborted();
    throw Error(error instanceof Error && error.message.includes('50 頁') ? error.message : 'PDF 無法完整解析或需要密碼，請開啟官方入口核對。');
  } finally { signal.removeEventListener('abort', abort); await task.destroy(); }
}

export class TfdaDocuments {
  constructor(private db: DrugDatabase, private request: typeof fetch = fetch) {}

  private decode(row?: Row) {
    if (!row || !Buffer.isBuffer(row.pdf) || row.pdf.length < 1 || row.pdf.length > maxBytes) return undefined;
    try {
      const m = JSON.parse(row.metadata) as Metadata;
      if (hash(row.metadata) !== row.id || m.product.id !== row.drug_id || m.sourceUrl !== row.source_url ||
          !isDirectTfdaPdf(m.sourceUrl, row.drug_id) || !/^[a-f0-9]{64}$/.test(m.indexSha256) ||
          !Number.isFinite(Date.parse(m.retrievedAt)) || !Number.isFinite(Date.parse(m.indexRetrievedAt)) ||
          !Number.isSafeInteger(m.pageCount) || m.pageCount < 1 || m.pageCount > 50 ||
          m.byteLength !== row.pdf.length || m.sha256 !== hash(row.pdf)) return undefined;
      const document: TfdaLabelDocument = { url: localTfdaDocumentPath(row.id, m.sha256), sha256: m.sha256,
        retrievedAt: m.retrievedAt, byteLength: m.byteLength, sourceUrl: m.sourceUrl };
      return { row, meta: m, document };
    } catch { return undefined; }
  }

  read(id: string, sha256: string) {
    const found = this.decode(this.db.prepare('SELECT * FROM tfda_documents WHERE id=?').get(id) as Row | undefined);
    if (!found || found.document.sha256 !== sha256) return undefined;
    return { ...found.document, pdf: found.row.pdf, title: `${found.meta.product.name} · 官方仿單副本（${found.meta.product.id}）` };
  }

  private current(drug: DrugCandidate, sourceUrl: string) {
    const row = this.db.prepare(`SELECT d.* FROM tfda_document_heads h JOIN tfda_documents d ON d.id=h.document_id
      WHERE h.drug_id=? AND h.source_url=?`).get(drug.id, sourceUrl) as Row | undefined;
    const found = this.decode(row);
    return found && JSON.stringify(found.meta.product) === JSON.stringify(identity(drug)) && found.meta.sourceUrl === sourceUrl ? found : undefined;
  }

  attach(report: MedicationReport): MedicationReport {
    return { ...report, medications: report.medications.map(entry => {
      const index = entry.taiwanLabelIndex;
      if (!index) return entry;
      return { ...entry, taiwanLabelIndex: { ...index, documents: index.labelUrls.flatMap(url => {
        const found = this.current(entry.drug, url); return found ? [found.document] : [];
      }) } };
    }) };
  }

  async save(input: TfdaDocumentRequest, signal: AbortSignal): Promise<TfdaLabelDocument> {
    const snapshot = () => {
      const drug = getTfda(this.db, input.licenseId), index = drug && readTfdaLabelIndex(this.db, drug);
      if (!drug || !index || index.sha256 !== input.indexSha256 || !index.labelUrls.includes(input.sourceUrl) || !isDirectTfdaPdf(input.sourceUrl, drug.id))
        throw Error('藥品或官方索引已變動，或此連結不是可保存的 PDF；請重新分析後再選擇。');
      return { drug, index };
    };
    signal.throwIfAborted(); const before = snapshot(), previous = this.current(before.drug, input.sourceUrl);
    if (previous && !input.refresh) return previous.document;
    const bounded: typeof fetch = (url, options) => this.request(url, { ...options, redirect: 'error',
      signal: AbortSignal.any([signal, options?.signal || AbortSignal.timeout(30_000)]) });
    let bytes: Buffer;
    try { bytes = await downloadBounded(input.sourceUrl, maxBytes, bounded, 30_000); }
    catch { signal.throwIfAborted(); throw Error('官方 PDF 暫時無法下載、轉址或超過 5 MB；已保存的副本會保留。'); }
    const pageCount = await validatePdf(bytes, signal);
    signal.throwIfAborted(); const after = snapshot();
    if (JSON.stringify(identity(before.drug)) !== JSON.stringify(identity(after.drug))) throw Error('下載期間藥品資料已變動，未保存，請重新分析。');
    const sha256 = hash(bytes);
    // A refresh can point back to an older version. Its original acquisition date
    // stays intact, while immutable document URLs in earlier reports keep working.
    const existing = (this.db.prepare('SELECT * FROM tfda_documents WHERE drug_id=? AND source_url=?').all(before.drug.id, input.sourceUrl) as Row[])
      .map(row => this.decode(row)).find(found => found?.meta.sha256 === sha256 && JSON.stringify(found.meta.product) === JSON.stringify(identity(before.drug)));
    const meta: Metadata = { product: identity(before.drug), sourceUrl: input.sourceUrl, indexSha256: before.index.sha256,
      indexRetrievedAt: before.index.retrievedAt, sha256, retrievedAt: new Date().toISOString(), byteLength: bytes.length, pageCount };
    const metadata = JSON.stringify(meta), id = existing?.row.id || hash(metadata);
    this.db.transaction(() => {
      if (!existing) this.db.prepare('INSERT INTO tfda_documents VALUES(?,?,?,?,?)').run(id, before.drug.id, input.sourceUrl, metadata, bytes);
      this.db.prepare('INSERT OR REPLACE INTO tfda_document_heads VALUES(?,?,?)').run(before.drug.id, input.sourceUrl, id);
    })();
    return existing?.document || { url: localTfdaDocumentPath(id, sha256), sourceUrl: input.sourceUrl, sha256, retrievedAt: meta.retrievedAt, byteLength: bytes.length };
  }
}

export function tfdaDocumentRouter(store: TfdaDocuments) {
  const router = Router(); let busy = false;
  router.get('/:id/:filename', (req, res) => {
    const match = /^([a-f0-9]{64})\.(pdf|json)$/.exec(req.params.filename);
    const result = /^[a-f0-9]{64}$/.test(req.params.id) && match && store.read(req.params.id, match[1]);
    if (!result) { res.status(404).json({ error: '這一版仿單未保存或已損毀，請重新分析或核對原始來源。' }); return; }
    res.setHeader('Cache-Control', 'private, no-cache'); res.setHeader('X-Content-Type-Options', 'nosniff');
    const { pdf, ...metadata } = result;
    if (match[2] === 'json') res.json(metadata);
    else { res.setHeader('Content-Disposition', `inline; filename="source-${result.sha256}.pdf"`); res.type('application/pdf').send(pdf); }
  });
  router.post('/', async (req, res) => {
    const body = req.body;
    if (typeof body?.licenseId !== 'string' || body.licenseId.length > 80 || typeof body.sourceUrl !== 'string' || body.sourceUrl.length > 2000 ||
        typeof body.indexSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(body.indexSha256) || (body.refresh !== undefined && typeof body.refresh !== 'boolean')) {
      res.status(400).json({ error: '請從藥品說明書中的官方仿單清單選擇文件。' }); return;
    }
    if (busy) { res.status(429).json({ error: '正在保存另一份仿單，請稍後再試。' }); return; }
    busy = true;
    const controller = new AbortController(), close = () => controller.abort(); res.on('close', close);
    const timeout = setTimeout(() => {
      controller.abort();
      if (!res.headersSent && !res.destroyed) res.status(504).json({ error: '保存仿單逾時，原有副本仍保留，請稍後重試。' });
    }, 30_000);
    try {
      const document = await store.save(body, controller.signal);
      if (!controller.signal.aborted && !res.destroyed) res.json(document);
    } catch (error) { if (!controller.signal.aborted && !res.destroyed) res.status(422).json({ error: (error as Error).message }); }
    finally { clearTimeout(timeout); res.off('close', close); busy = false; }
  });
  return router;
}
