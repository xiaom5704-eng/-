import 'dotenv/config';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { openDrugDatabase } from '../server/medications/store';
import { ddinterDrugUrl, ddinterGraphUrl, importDdinterGraph, parseDdinterGraph } from '../server/medications/ddinter-supplements';
import { downloadBounded } from './verified-download.mjs';

interface Archive { schema: 1; id: string; retrievedAt: string; sourceUrl: string; dataUrl: string; sha256: string; raw: string }
async function main() {
  const args = process.argv.slice(2);
  const ids = args.filter(arg => /^--id=DDInter\d+$/.test(arg)).map(arg => arg.slice(5));
  const files = args.filter(arg => arg.startsWith('--file=')).map(arg => arg.slice(7));
  if (!args.length || args.length > 5 || args.length !== ids.length + files.length || (ids.length && files.length) ||
      new Set(ids).size !== ids.length || files.some(file => !file))
    throw new Error('用法：npm run data:enrich-ddinter-web -- --id=DDInter1996（最多五個 ID）；或 --file=已保存的快照.json');
  const archives: Archive[] = [];
  for (const file of files) {
    const archive = JSON.parse(await readFile(file, 'utf8')) as Archive;
    if (archive.schema !== 1 || typeof archive.raw !== 'string' ||
        archive.sha256 !== createHash('sha256').update(archive.raw).digest('hex') ||
        archive.sourceUrl !== ddinterDrugUrl(archive.id) || archive.dataUrl !== ddinterGraphUrl(archive.id))
      throw new Error('保存的 DDInter 快照格式、來源或雜湊不符。');
    parseDdinterGraph(archive.raw, archive.id);
    archives.push(archive);
  }
  for (const id of ids) {
    const dataUrl = ddinterGraphUrl(id);
    const bytes = await downloadBounded(dataUrl, 4_000_000, fetch, 30_000);
    const raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    parseDdinterGraph(raw, id);
    const archive: Archive = { schema: 1, id, retrievedAt: new Date().toISOString(), sourceUrl: ddinterDrugUrl(id), dataUrl,
      sha256: createHash('sha256').update(raw).digest('hex'), raw };
    await mkdir('data/raw/ddinter-web', { recursive: true });
    const file = `data/raw/ddinter-web/${id}-${Date.now()}.json`;
    await writeFile(file, JSON.stringify(archive, null, 2), { flag: 'wx' });
    console.log(JSON.stringify({ downloaded: id, archive: file }));
    archives.push(archive);
    if (id !== ids.at(-1)) await delay(500);
  }
  if (new Set(archives.map(archive => archive.id)).size !== archives.length) throw new Error('同一次匯入不可重複指定相同成分。');
  const db = openDrugDatabase();
  try {
    const results = db.transaction(() => archives.map(a => importDdinterGraph(db, a.raw, a.id, a.retrievedAt)))();
    console.log(JSON.stringify({ imported: results, note: '僅保存官方成分圖的配對等級，非完整網站或完整處置內容；一般查詢不連外。' }, null, 2));
  } finally { db.close(); }
}
main().catch(error => { console.error(error instanceof Error ? error.message : 'DDInter 網站補充失敗'); process.exitCode = 1; });
