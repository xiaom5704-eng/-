import { createHash } from 'node:crypto';
import { parse, type DefaultTreeAdapterTypes as Tree } from 'parse5';
import type { InteractionDetail } from '../../shared/interaction-detail';
import { normalizeName, type DrugDatabase } from './store';

export const ddinterDetailUrl = (id: string) => `https://ddinter2.scbdd.com/server/interact/${id}/`;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const attr = (node: Tree.Element, name: string) => node.attrs.find(a => a.name === name)?.value;
const hasClass = (node: Tree.Element, name: string) => attr(node, 'class')?.split(/\s+/).includes(name);
const children = (node: Tree.Node): Tree.ChildNode[] => 'childNodes' in node ? node.childNodes : [];

function elements(root: Tree.Node): Tree.Element[] {
  const result: Tree.Element[] = [];
  const pending = [{ node: root, depth: 0 }];
  let count = 0;
  while (pending.length) {
    const { node, depth } = pending.pop()!;
    if (++count > 25_000 || depth > 64) throw new Error('DDInter 詳細頁結構過於複雜。');
    if ('tagName' in node) {
      if (['script', 'style', 'template', 'noscript'].includes(node.tagName)) continue;
      result.push(node);
    }
    pending.push(...children(node).map(child => ({ node: child, depth: depth + 1 })).reverse());
  }
  return result;
}

// Source markup is parsed as data, never executed or rendered as HTML.
function plainText(node: Tree.Node): string {
  if (node.nodeName === '#text') return (node as Tree.TextNode).value;
  if ('tagName' in node && ['script', 'style', 'template', 'noscript'].includes(node.tagName)) return '';
  return children(node).map(plainText).join(' ');
}
const text = (node: Tree.Node) => plainText(node).replace(/\s+/g, ' ').trim();
const one = <T>(values: T[], label: string): T => {
  if (values.length !== 1) throw new Error(`DDInter 詳細頁的 ${label} 缺漏或重複；未匯入。`);
  return values[0];
};
const boundedText = (node: Tree.Node, label: string, limit = 30_000) => {
  const value = text(node);
  if (!value || value.length > limit) throw new Error(`DDInter 詳細頁的 ${label} 內容無效。`);
  return value;
};

export function parseDdinterDetail(raw: string) {
  if (!raw || Buffer.byteLength(raw) > 2_000_000 || raw.includes('\0')) throw new Error('DDInter 詳細頁大小或內容無效。');
  const all = elements(parse(raw));
  const main = one(all.filter(n => n.tagName === 'main'), '主文');
  const body = elements(main);
  const banner = one(body.filter(n => attr(n, 'role') === 'alert'), '配對標頭');
  const header = elements(banner);
  const names = header.filter(n => n.tagName === 'strong').map(n => boundedText(n, '成分名稱', 300));
  if (names.length !== 2 || !text(banner).startsWith('Interaction between ')) throw new Error('DDInter 詳細頁配對標頭不符。');
  const level = text(one(header.filter(n => hasClass(n, 'badge') && ['Major', 'Moderate', 'Minor', 'Unknown'].includes(text(n))), '等級'));
  const table = one(body.filter(n => n.tagName === 'table' && elements(n).some(cell => cell.tagName === 'td' && hasClass(cell, 'key') && text(cell) === 'Interaction')), '基本資料表');
  const rows = elements(table).filter(n => n.tagName === 'tr');
  function valueFor(key: string) {
    const row = one(rows.filter(row => children(row).some(n => 'tagName' in n && n.tagName === 'td' && hasClass(n, 'key') && text(n) === key)), key);
    return one(children(row).filter((n): n is Tree.Element => 'tagName' in n && n.tagName === 'td' && hasClass(n, 'value')), `${key} 內容`);
  }
  const idCell = valueFor('ID');
  const links = elements(idCell).filter(n => n.tagName === 'a');
  const ids = links.map(link => {
    const match = /^\/server\/drug-detail\/(DDInter\d+)\/$/.exec(attr(link, 'href') || '');
    if (!match || text(link) !== match[1]) throw new Error('DDInter 詳細頁成分 ID 不符。');
    return match[1];
  });
  if (ids.length !== 2 || ids[0] === ids[1]) throw new Error('DDInter 詳細頁必須包含兩個不同成分。');
  const ordered = ids.map((id, i) => ({ id, name: names[i] }));
  // Use the same lexicographic ordering as the CSV / graph pair keys.
  ordered.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const referenceCell = valueFor('References');
  const references = children(referenceCell).filter((n): n is Tree.Element => 'tagName' in n && n.tagName === 'span').map(n => boundedText(n, '參考文獻', 2000));
  if (references.length > 100 || references.join(' ') !== text(referenceCell)) throw new Error('DDInter 詳細頁參考文獻格式不符。');
  const content = { drugIds: ordered.map(n => n.id) as [string, string], drugNames: ordered.map(n => n.name) as [string, string], level,
    interaction: boundedText(valueFor('Interaction'), 'Interaction'), management: boundedText(valueFor('Management'), 'Management'), references };
  return { ...content, contentSha256: digest(JSON.stringify(content)) };
}

export function initializeDdinterDetails(db: DrugDatabase) {
  db.exec(`CREATE TABLE IF NOT EXISTS ddinter_pair_details (id TEXT PRIMARY KEY, drug_a TEXT NOT NULL, drug_b TEXT NOT NULL,
    level TEXT NOT NULL, payload TEXT NOT NULL, raw TEXT NOT NULL, UNIQUE(drug_a,drug_b));`);
}

export interface DdinterDetailArchive { schema: 1; id: string; retrievedAt: string; sourceUrl: string; sha256: string; raw: string }
export function validateDdinterDetailArchive(value: unknown): DdinterDetailArchive {
  const a = value as Partial<DdinterDetailArchive> | null;
  if (!a || a.schema !== 1 || typeof a.id !== 'string' || !/^[1-9]\d{0,11}$/.test(a.id) ||
      typeof a.raw !== 'string' || Buffer.byteLength(a.raw) > 2_000_000 || a.sha256 !== digest(a.raw) ||
      a.sourceUrl !== ddinterDetailUrl(a.id) || typeof a.retrievedAt !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T/.test(a.retrievedAt) || !Number.isFinite(Date.parse(a.retrievedAt)))
    throw new Error('保存的 DDInter 詳細頁格式、來源、時間或雜湊不符。');
  parseDdinterDetail(a.raw);
  return a as DdinterDetailArchive;
}

function currentPairMatches(db: DrugDatabase, detail: Pick<InteractionDetail, 'drugIds' | 'drugNames' | 'level'>) {
  const pairs = db.prepare('SELECT level FROM ddinter_all_pairs WHERE drug_a=? AND drug_b=?').all(...detail.drugIds) as { level: string }[];
  return pairs.length === 1 && pairs[0].level === detail.level && detail.drugIds.every((id, i) => {
    const rows = db.prepare('SELECT normalized_name FROM ddinter_all_drugs WHERE id=?').all(id) as { normalized_name: string }[];
    return rows.length === 1 && rows[0].normalized_name === normalizeName(detail.drugNames[i]);
  });
}

// Reviewed paraphrases are bound to the exact parsed source content, not a drug
// name alone. A changed source continues to show its original text, without an
// outdated Chinese explanation. No model/API call is made while querying.
function reviewedSummary(id: string, hash: string): InteractionDetail['summary'] {
  if (id !== '270023' || hash !== '975f43d327b4707b89cd45ef24b6d644ef9521decdceea80907532cfdb3249c6') return undefined;
  return { reviewedAt: '2026-09-23', text: '來源指出，具有抗膽鹼作用的藥物併用，可能加重便秘、心跳加快等副作用，嚴重時可能出現腸麻痺；鎮靜作用也可能疊加。請由醫師或藥師確認是否適合併用。' };
}

export function importDdinterDetail(db: DrugDatabase, raw: string, id: string, retrievedAt: string) {
  if (!/^[1-9]\d{0,11}$/.test(id) || !/^\d{4}-\d{2}-\d{2}T/.test(retrievedAt) || !Number.isFinite(Date.parse(retrievedAt))) throw new Error('DDInter 詳細頁 ID 或取得時間無效。');
  const parsed = parseDdinterDetail(raw);
  const detail: InteractionDetail = { id, ...parsed, sourceUrl: ddinterDetailUrl(id), retrievedAt, sha256: digest(raw) };
  return db.transaction(() => {
    if (!currentPairMatches(db, detail)) throw new Error('DDInter 詳細頁與本機配對的成分名稱或等級不符；保留原資料。');
    const previous = db.prepare('SELECT drug_a,drug_b FROM ddinter_pair_details WHERE id=?').get(id) as { drug_a: string; drug_b: string } | undefined;
    if (previous && (previous.drug_a !== detail.drugIds[0] || previous.drug_b !== detail.drugIds[1])) throw new Error('DDInter 詳細頁 ID 對應的配對已改變；保留原資料。');
    db.prepare(`INSERT INTO ddinter_pair_details VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
      level=excluded.level,payload=excluded.payload,raw=excluded.raw`).run(id, ...detail.drugIds, detail.level, JSON.stringify(detail), raw);
    return { id, drugIds: detail.drugIds, retrievedAt, sha256: detail.sha256, contentSha256: detail.contentSha256 };
  })();
}

export function readDdinterDetail(db: DrugDatabase, drugA: string, drugB: string, level: string): InteractionDetail | undefined {
  const row = db.prepare('SELECT payload FROM ddinter_pair_details WHERE drug_a=? AND drug_b=? AND level=?').get(drugA, drugB, level) as { payload: string } | undefined;
  if (!row) return undefined;
  const detail = JSON.parse(row.payload) as InteractionDetail;
  if (!currentPairMatches(db, detail)) return undefined;
  return { ...detail, summary: reviewedSummary(detail.id, detail.contentSha256) };
}
