export interface PackageStarterItem {
  id: string; name: string; drugId: string; sourceUrl: string; note: string;
}
export interface PackageStarterResult {
  item: PackageStarterItem; outcome: 'saved' | 'reused' | 'failed'; usablePages: number; message: string;
}
