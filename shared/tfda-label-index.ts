import type { SavedSourceDocument } from './source-document';

export interface TfdaLabelDocument extends SavedSourceDocument { sourceUrl: string }
export type LabelSavedHandler = (entry: TfdaLabelIndexEntry, document: TfdaLabelDocument) => void;

export const tfdaLabelIndexUrl = 'https://data.gov.tw/dataset/9117';
export const tfdaLabelDownloadUrl = 'https://data.fda.gov.tw/data/opendata/export/39/json';

export interface TfdaLabelIndexEntry {
  licenseId: string;
  name: string;
  englishName: string;
  labelUrls: string[];
  packageUrls: string[];
  unavailableLabelLinks: number;
  retrievedAt: string;
  sha256: string;
  sourceUrl: string;
  documents?: TfdaLabelDocument[];
}

export const isDirectTfdaPdf = (url: string, licenseId: string) => validTfdaLabelUrl(url, licenseId, 'label') && new URL(url).pathname.startsWith('/insert/pdfcasefile/');

// Keep the source's link, including exportpdf routes that may redirect to HTML.
// A link in this index does not establish a PDF format, version or local copy.
export function validTfdaLabelUrl(value: string, licenseId: string, kind: 'label' | 'package') {
  try {
    const url = new URL(value);
    if (url.origin !== 'https://mcp.fda.gov.tw' || url.username || url.password || url.hash ||
        (url.search !== '' && url.search !== '?c=2')) return false;
    const pathname = decodeURIComponent(url.pathname);
    if (kind === 'label' && pathname === `/exportpdf/${licenseId}`) return true;
    return kind === 'label' ? /^\/insert\/pdfcasefile\/[\w-]+$/.test(pathname)
      : /^\/insert\/lablefiles\/[\w-]+$/.test(pathname);
  } catch { return false; }
}
