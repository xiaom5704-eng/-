import 'dotenv/config';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { documentSources, importSourceDocument, MAX_DOCUMENT_BYTES, validateDocumentBytes } from '../server/medications/source-documents';
import { openDrugDatabase } from '../server/medications/store';
import { downloadBounded } from './verified-download.mjs';

interface Archive { schema: 1; sourceId: string; sourceUrl: string; sha256: string; retrievedAt: string; base64: string }
async function main() {
  const args = process.argv.slice(2), arg = args[0] || '';
  if (args.length !== 1 || !(arg === '--all' || /^--id=[a-z0-9-]+$/.test(arg) || /^--file=.+/.test(arg)))
    throw new Error('用法：npm run data:cache-documents -- --all；或 --id=已核對來源ID；或 --file=封存檔.json');
  const archives: Archive[] = [];
  if (arg.startsWith('--file=')) {
    const file = arg.slice(7);
    if ((await stat(file)).size > 24_000_000) throw new Error('仿單封存檔過大。');
    const input = JSON.parse(await readFile(file, 'utf8'));
    if (!Array.isArray(input) || !input.length || input.length > documentSources.length) throw new Error('仿單封存檔清單無效。');
    for (const a of input) {
      const spec = documentSources.find(source => source.id === a?.sourceId);
      if (!spec || a.schema !== 1 || a.sourceUrl !== spec.source.url || a.sha256 !== spec.sha256 ||
          typeof a.retrievedAt !== 'string' || typeof a.base64 !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(a.base64)) throw new Error('仿單封存檔来源或內容無效。');
      const bytes = Buffer.from(a.base64, 'base64');
      if (bytes.toString('base64') !== a.base64) throw new Error('仿單封存檔編碼無效。');
      validateDocumentBytes(bytes, spec); archives.push(a);
    }
    if (new Set(archives.map(a => a.sourceId)).size !== archives.length) throw new Error('仿單封存檔有重複來源。');
  } else {
    const sources = arg === '--all' ? documentSources : documentSources.filter(source => source.id === arg.slice(5));
    if (!sources.length) throw new Error('未收錄此來源；請先核對原始文件。');
    for (const spec of sources) {
      const bytes = await downloadBounded(spec.source.url, MAX_DOCUMENT_BYTES, (url, options) => fetch(url, { ...options, redirect: 'error' }), 30_000);
      validateDocumentBytes(bytes, spec);
      archives.push({ schema: 1, sourceId: spec.id, sourceUrl: spec.source.url, sha256: spec.sha256, retrievedAt: new Date().toISOString(), base64: bytes.toString('base64') });
    }
    await mkdir('data/raw/source-documents', { recursive: true });
    const file = `data/raw/source-documents/documents-${Date.now()}.json`;
    await writeFile(file, JSON.stringify(archives, null, 2), { flag: 'wx' });
    console.log(JSON.stringify({ archive: file, documents: archives.length }));
  }
  const db = openDrugDatabase();
  try { console.log(JSON.stringify(db.transaction(() => archives.map(a => importSourceDocument(db, a.sourceId, Buffer.from(a.base64, 'base64'), a.retrievedAt)))(), null, 2)); }
  finally { db.close(); }
}
main().catch(error => { console.error(error instanceof Error ? error.message : '本機仿單保存失敗'); process.exitCode = 1; });
