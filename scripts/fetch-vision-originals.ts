import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { loadRuntimeConfig } from '../server/runtime';
import { getTfda, openDrugDatabase } from '../server/medications/store';
import { allowedOriginalUrl, ReferenceOriginals } from '../server/vision/reference-originals';

async function main() {
  const args = process.argv.slice(2);
  if (args.some(arg => !/^--limit=\d+$/.test(arg) && !/^--id=.+/.test(arg) && arg !== '--refresh'))
    throw new Error('用法：npm run vision:originals -- [--limit=20] [--id=完整許可證字號] [--refresh]');
  const limit = Number(args.find(arg => arg.startsWith('--limit='))?.slice(8) || 20);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10000) throw new Error('limit 請填 1–10000。');
  const config = loadRuntimeConfig(), db = openDrugDatabase(config.paths.drugDb);
  try {
    const originals = new ReferenceOriginals(db, path.join(config.paths.vision, 'originals'));
    const ids = args.filter(arg => arg.startsWith('--id=')).map(arg => arg.slice(5));
    if (ids.some(id => !getTfda(db, id))) throw new Error('指定的許可證未在本機找到，請先核對字號。');
    const rows = ids.length ? [...new Set(ids)] : (db.prepare('SELECT id FROM tfda_appearances ORDER BY id').all() as { id: string }[]).map(row => row.id);
    const saved = new Set<string>();
    if (!args.includes('--refresh')) for (let offset = 0; offset < rows.length; offset += 500)
      for (const row of originals.forDrugs(rows.slice(offset, offset + 500))) saved.add(`${row.drug_id}\0${row.source_url}`);
    const pending = rows.flatMap(id => {
      return (getTfda(db, id)?.appearance?.imageUrls || []).filter(url => allowedOriginalUrl(url) && !saved.has(`${id}\0${url}`)).map(url => ({ id, url }));
    }).slice(0, limit);
    console.log(JSON.stringify({ pending: pending.length, limit, source: 'TFDA official images', note: '只更新本機放大對照圖片，不改變 CV 模型或特徵索引。' }));
    const results = []; let consecutiveFailures = 0;
    for (const source of pending) {
      try { results.push({ ...source, status: 'saved', image: await originals.download(source.id, source.url) }); consecutiveFailures = 0; }
      catch (error) { results.push({ ...source, status: 'failed', error: error instanceof Error ? error.message : '下載失敗' }); consecutiveFailures++; }
      console.log(JSON.stringify(results.at(-1)));
      if (consecutiveFailures >= 3) { console.error('連續三筆失敗，停止下載；既有圖片保留，下次可續做。'); break; }
    }
    const reportRoot = path.join(config.root, 'data/reports'); await mkdir(reportRoot, { recursive: true });
    const filename = path.join(reportRoot, `reference-originals-${Date.now()}.json`);
    await writeFile(filename, JSON.stringify({ checkedAt: new Date().toISOString(), results, source: 'https://data.gov.tw/dataset/9120', license: '政府資料開放授權條款第 1 版', transform: 'WebP quality 95; longest side <=8192; no upscaling' }, null, 2));
    console.log(JSON.stringify({ report: filename, saved: results.filter(row => row.status === 'saved').length, failed: results.filter(row => row.status === 'failed').length }));
    if (results.some(row => row.status === 'failed')) process.exitCode = 2;
  } finally { db.close(); }
}
main().catch(error => { console.error(error instanceof Error ? error.message : '官方原圖匯入失敗'); process.exitCode = 1; });
