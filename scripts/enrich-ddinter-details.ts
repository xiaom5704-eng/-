import 'dotenv/config';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { openDrugDatabase } from '../server/medications/store';
import { ddinterDetailUrl, importDdinterDetail, validateDdinterDetailArchive, type DdinterDetailArchive } from '../server/medications/ddinter-details';
import { downloadBounded } from './verified-download.mjs';

async function main() {
  const args = process.argv.slice(2), arg = args[0] || '';
  if (args.length !== 1 || !(/^--id=[1-9]\d{0,11}$/.test(arg) || /^--file=.+/.test(arg)))
    throw new Error('用法：npm run data:enrich-ddinter-details -- --id=270023；或 --file=已保存的詳細頁.json');
  let archive: DdinterDetailArchive;
  if (arg.startsWith('--file=')) {
    const file = arg.slice(7);
    if ((await stat(file)).size > 12_000_000) throw new Error('DDInter 詳細頁封存檔過大。');
    archive = validateDdinterDetailArchive(JSON.parse(await readFile(file, 'utf8')));
  } else {
    const id = arg.slice(5), sourceUrl = ddinterDetailUrl(id);
    const bytes = await downloadBounded(sourceUrl, 2_000_000, (url, options) => fetch(url, { ...options, redirect: 'error' }), 30_000);
    const raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    archive = validateDdinterDetailArchive({ schema: 1, id, sourceUrl, raw, retrievedAt: new Date().toISOString(), sha256: createHash('sha256').update(raw).digest('hex') });
    await mkdir('data/raw/ddinter-details', { recursive: true });
    const file = `data/raw/ddinter-details/${id}-${Date.now()}.json`;
    await writeFile(file, JSON.stringify(archive, null, 2), { flag: 'wx' });
    console.log(JSON.stringify({ downloaded: id, archive: file }));
  }
  const db = openDrugDatabase();
  try {
    console.log(JSON.stringify({ imported: importDdinterDetail(db, archive.raw, archive.id, archive.retrievedAt), note: '僅補入已核對配對的來源原文；一般查詢不連外，也不改變配對或年齡提醒。' }, null, 2));
  } finally { db.close(); }
}
main().catch(error => { console.error(error instanceof Error ? error.message : 'DDInter 詳細頁補充失敗'); process.exitCode = 1; });
