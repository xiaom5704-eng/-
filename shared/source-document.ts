export interface SavedSourceDocument {
  url: string;
  sha256: string;
  retrievedAt: string;
  byteLength: number;
}

export const localDocumentPath = (sha256: string) => `/api/medications/source-documents/${sha256}.pdf`;
export const isLocalDocumentPath = (value: string) => /^\/api\/medications\/source-documents\/[a-f0-9]{64}\.pdf$/.test(value);
export const validLocalDocument = (value: SavedSourceDocument) => !!value && typeof value.sha256 === 'string' && /^[a-f0-9]{64}$/.test(value.sha256) &&
  value.url === localDocumentPath(value.sha256) && typeof value.retrievedAt === 'string' && Number.isFinite(Date.parse(value.retrievedAt)) &&
  Number.isSafeInteger(value.byteLength) && value.byteLength > 0 && value.byteLength <= 5_000_000;
