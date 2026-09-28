import type { PackageStarterItem, PackageStarterResult } from '../../shared/package-starter';
import type { OfficialPackageReferences } from './official-packages';

export interface ReviewedPackage extends PackageStarterItem {
  identitySha256: string; sourceSha256: string; pageCount: number; reviewedPages: number[];
}

// Reviewed against the complete official artwork on 2026-09-28. Pin the
// product identity AND document bytes: the same URL alone is not a review.
const catalog: ReviewedPackage[] = [
  {
    id: 'panadol-cold-extra-8', name: '普拿疼伏冒加強錠', drugId: '衛署藥輸字第023784號',
    sourceUrl: 'https://mcp.fda.gov.tw/insert/lablefiles/2ea6aab5-dfbf-4189-8f43-8c5a2bf1c4ee_1?c=2',
    note: '8 錠裝展開稿，可能與手上的包裝版本不同。',
    identitySha256: 'b4d222a19608f65166f8e884c4583bf9b35bf82d1f73722d2ffecd924d5ee312',
    sourceSha256: '37841a6ebbfc11b2c116438eb4b67c0107c157e4be47fe1dca4a974e5d62629b',
    pageCount: 1, reviewedPages: [1],
  },
  {
    id: 'uchu-cold', name: '斯斯感冒加強錠', drugId: '衛署藥製字第049576號',
    sourceUrl: 'https://mcp.fda.gov.tw/insert/lablefiles/2fc887e3-6afa-4d51-8d46-a1ab084ace6d_7?c=2',
    note: '正反面標籤稿，可能與手上的包裝版本不同。',
    identitySha256: 'a503865d7a5f5d309653b8a7315968f6a509ce6ce84a9b669e88290d9385498a',
    sourceSha256: '51ee257097a46898f6f5d65bb2c4a4890e696191c7f1d8f0f0629edaedc6761a',
    pageCount: 1, reviewedPages: [1],
  },
];

const publicItem = ({ id, name, drugId, sourceUrl, note }: PackageStarterItem): PackageStarterItem => ({ id, name, drugId, sourceUrl, note });
export const packageStarterItems = () => catalog.map(publicItem);

export async function preparePackageStarters(store: OfficialPackageReferences, signal: AbortSignal, entries = catalog): Promise<PackageStarterResult[]> {
  const results: PackageStarterResult[] = [];
  for (const entry of entries) {
    signal.throwIfAborted();
    try {
      const saved = await store.saveReviewed(entry, signal);
      signal.throwIfAborted();
      const usablePages = store.snapshot(entry.drugId).library.photos.filter(photo => photo.sourceUrl === entry.sourceUrl && photo.usable).length;
      results.push({ item: publicItem(entry), outcome: saved.reused ? 'reused' : 'saved', usablePages,
        message: usablePages ? `${saved.reused ? '沿用本機圖片' : '已下載'}，${usablePages} 頁可比對。` : '已保存，沿用您原先的待核對或停用設定；可從官方外盒清單查看。' });
    } catch (error) {
      signal.throwIfAborted();
      results.push({ item: publicItem(entry), outcome: 'failed', usablePages: 0, message: (error as Error).message });
    }
  }
  return results;
}
