import { createHash } from 'node:crypto';
import { caseProducts, matchesCaseProduct, safetySources } from '../../shared/medication-safety';
import type { DrugCandidate, MedicationReport } from '../../shared/medication';
import { localDocumentPath, type SavedSourceDocument } from '../../shared/source-document';
import { getTfda, type DrugDatabase } from './store';

// Exact source PDFs visually checked 2026-09-23/24, including license, formulation
// and every page. Add a new catalog entry for a revised file; retain old hashes
// so saved reports can continue to open the exact version they cited.
export const documentSources = [
  { id: 'noscapine-20260923', product: caseProducts[0], source: safetySources.noscapine,
    sha256: '22ae2976b0fc43fca750146f79293b3e14f23a38a914ac8fd57e938a0aa3de2c' },
  { id: 'cypromin-2012', product: caseProducts[2], source: safetySources.cypromin,
    sha256: '88a1f86fe8d038490d8a37dc1e8cd96579ae7d343646a08be141515507b3122b' },
  { id: 'kbt-2023', product: caseProducts[3], source: safetySources.kbt,
    sha256: 'fcd511636dfb60da0917df367837c02df472a227e061ac253e6d67f98a77d6e4' },
  { id: 'somin-2022', product: caseProducts[1], source: safetySources.sominLabel,
    sha256: '2408aa630735f96fcd5d1f79102d09761155a438dddb7f5704be673906e84bfc' },
  { id: 'fencaine-2015', product: caseProducts[4], source: safetySources.fencaineLabel,
    sha256: 'fdfcae0affc1c40cc4374374cd46c6a8deb059b15bba7ad593cd7d7ed65d8605' },
] as const;
export type DocumentSource = typeof documentSources[number];
export const MAX_DOCUMENT_BYTES = 5_000_000;
export const documentHash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

export function initializeSourceDocuments(db: DrugDatabase) {
  db.exec(`CREATE TABLE IF NOT EXISTS local_source_documents (sha256 TEXT PRIMARY KEY, source_id TEXT NOT NULL,
    source_url TEXT NOT NULL, retrieved_at TEXT NOT NULL, pdf BLOB NOT NULL);`);
}

export function validateDocumentBytes(bytes: Uint8Array, spec: DocumentSource) {
  const data = Buffer.from(bytes);
  if (!data.length || data.length > MAX_DOCUMENT_BYTES || data.subarray(0, 5).toString('ascii') !== '%PDF-' ||
      !data.subarray(-1024).toString('ascii').includes('%%EOF') || documentHash(data) !== spec.sha256)
    throw new Error('仿單內容與已核對版本不符，或檔案損毀；保留原副本，請重新核對來源版本。');
}

export function importSourceDocument(db: DrugDatabase, sourceId: string, bytes: Uint8Array, retrievedAt: string) {
  const spec = documentSources.find(source => source.id === sourceId);
  if (!spec || !/^\d{4}-\d{2}-\d{2}T/.test(retrievedAt) || !Number.isFinite(Date.parse(retrievedAt))) throw new Error('仿單來源或取得時間無效。');
  validateDocumentBytes(bytes, spec);
  const drug = getTfda(db, spec.product.id);
  if (!drug || !matchesCaseProduct(drug, spec.product)) throw new Error('本機藥品的許可證或完整成分與仿單範圍不符；未匯入。');
  // Reimporting identical bytes never invents a newer acquisition date.
  const row = db.prepare('SELECT * FROM local_source_documents WHERE sha256=?').get(spec.sha256) as DocumentRow | undefined;
  if (!validRow(row, spec)) db.prepare('INSERT OR REPLACE INTO local_source_documents VALUES(?,?,?,?,?)')
    .run(spec.sha256, spec.id, spec.source.url, retrievedAt, Buffer.from(bytes));
  return { sourceId, sha256: spec.sha256, bytes: bytes.length, sourceUrl: spec.source.url };
}

interface DocumentRow { sha256: string; source_id: string; source_url: string; retrieved_at: string; pdf: Buffer }
function validRow(row: DocumentRow | undefined, spec: DocumentSource): row is DocumentRow {
  if (!row || row.source_id !== spec.id || row.source_url !== spec.source.url || row.sha256 !== spec.sha256 ||
      !/^\d{4}-\d{2}-\d{2}T/.test(row.retrieved_at) || !Number.isFinite(Date.parse(row.retrieved_at)) || !Buffer.isBuffer(row.pdf)) return false;
  try { validateDocumentBytes(row.pdf, spec); return true; } catch { return false; }
}

export function readSourceDocument(db: DrugDatabase, sha256: string) {
  const spec = documentSources.find(source => source.sha256 === sha256);
  if (!spec) return undefined;
  const row = db.prepare('SELECT * FROM local_source_documents WHERE sha256=?').get(sha256) as DocumentRow | undefined;
  if (!validRow(row, spec)) return undefined;
  return { pdf: row.pdf, title: `${spec.source.title}（${spec.source.version}）`, sourceUrl: spec.source.url,
    metadata: { url: localDocumentPath(sha256), sha256, retrievedAt: row.retrieved_at, byteLength: row.pdf.length } satisfies SavedSourceDocument };
}

export function attachSourceDocuments(db: DrugDatabase, report: MedicationReport): MedicationReport {
  const documents = new Map<string, SavedSourceDocument>();
  for (const spec of documentSources) {
    if (!report.medications.some(entry => matchesCaseProduct(entry.drug, spec.product))) continue;
    const saved = readSourceDocument(db, spec.sha256);
    if (saved && (!documents.has(spec.source.url) || documents.get(spec.source.url)!.retrievedAt < saved.metadata.retrievedAt)) documents.set(spec.source.url, saved.metadata);
  }
  return { ...report,
    medications: report.medications.map(entry => ({ ...entry, localLabel: entry.localLabel ? { ...entry.localLabel, document: documents.get(entry.localLabel.sourceUrl) } : undefined })),
    ...(report.safety ? { safety: { ...report.safety, alerts: report.safety.alerts.map(alert => ({ ...alert,
      sources: alert.sources.map(source => ({ ...source, document: documents.get(source.url) })) })) } } : {}),
  };
}

export function matchingDocumentProduct(drug: Pick<DrugCandidate, 'source' | 'id'> & Partial<Pick<DrugCandidate, 'ingredients'>>) {
  const spec = caseProducts.find(item => item.id === drug.id);
  return !!spec && Array.isArray(drug.ingredients) && matchesCaseProduct(drug as DrugCandidate, spec);
}
