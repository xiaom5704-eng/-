import { parseFragment, type DefaultTreeAdapterTypes } from 'parse5';

export type SourceTableNode = { type: 'text'; value: string } | {
  type: 'element'; tagName: string; properties: Record<string, string | number>; children: SourceTableNode[];
};
const tags = new Set(['table', 'caption', 'colgroup', 'col', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th',
  'p', 'span', 'br', 'strong', 'b', 'em', 'i', 'sup', 'sub', 'u', 's', 'del', 'ins', 'ul', 'ol', 'li']);
const aliases: Record<string, string> = { paragraph: 'p', content: 'span', footnote: 'span', a: 'span' };

// Parse without a browser DOM: source tags cannot execute or initiate requests.
// Rebuild only inert table/text elements. Unsupported content is reported instead
// of silently losing a formula, image, footnote reference or malformed span.
export function sourceTableNodes(html: string): SourceTableNode[] | undefined {
  if (!html.trim() || html.length > 512_000 || html.includes('\0')) return undefined;
  let visited = 0;
  const convert = (node: DefaultTreeAdapterTypes.ChildNode, depth: number): SourceTableNode[] => {
    if (++visited > 12_000 || depth > 64) throw new Error('表格過於複雜');
    if (node.nodeName === '#comment') return [];
    if ('value' in node) return [{ type: 'text', value: node.value }];
    if (!('tagName' in node) || node.namespaceURI !== 'http://www.w3.org/1999/xhtml') throw new Error('不支援的表格內容');
    const tagName = aliases[node.tagName] || node.tagName;
    if (!tags.has(tagName)) throw new Error('不支援的表格內容');
    const properties: Record<string, string | number> = {};
    for (const name of ['colspan', 'rowspan']) {
      const value = node.attrs.find(attr => attr.name === name)?.value.trim();
      if (value === undefined) continue;
      if (!['td', 'th'].includes(tagName) || !/^\d+$/.test(value) || Number(value) < (name === 'rowspan' ? 0 : 1) || Number(value) > 1000) throw new Error('無效的合併儲存格');
      properties[name === 'colspan' ? 'colSpan' : 'rowSpan'] = Number(value);
    }
    const scope = node.attrs.find(attr => attr.name === 'scope')?.value;
    if (tagName === 'th' && scope && ['row', 'col', 'rowgroup', 'colgroup'].includes(scope)) properties.scope = scope;
    let children = node.childNodes.flatMap(child => convert(child, depth + 1));
    // FDA SPL expresses emphasis via styleCode; retain it without CSS or events.
    const styles = (node.attrs.find(attr => attr.name === 'stylecode')?.value || '').toLowerCase().split(/\s+/);
    for (const [style, tag] of [['bold', 'strong'], ['italics', 'em'], ['underline', 'u']]) {
      if (styles.includes(style) && ['span', 'p'].includes(tagName)) children = [{ type: 'element', tagName: tag, properties: {}, children }];
    }
    return [{ type: 'element', tagName, properties, children }];
  };
  try {
    const fragment = parseFragment(html);
    const nodes = fragment.childNodes.filter(node => !('value' in node && !node.value.trim()) && node.nodeName !== '#comment');
    if (!nodes.length || nodes.some(node => !('tagName' in node) || node.tagName !== 'table')) return undefined;
    return nodes.flatMap(node => convert(node, 0));
  } catch { return undefined; }
}

const escapeHtml = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll('\r', '&#13;').replaceAll('\n', '&#10;');
export function sourceTableHtml(html: string): string | undefined {
  const nodes = sourceTableNodes(html);
  const serialize = (node: SourceTableNode): string => {
    if (node.type === 'text') return escapeHtml(node.value);
    const attrs = Object.entries(node.properties).map(([key, value]) => ` ${key.toLowerCase()}="${escapeHtml(String(value))}"`).join('');
    const start = `<${node.tagName}${attrs}>`;
    return ['br', 'col'].includes(node.tagName) ? start : `${start}${node.children.map(serialize).join('')}</${node.tagName}>`;
  };
  return nodes?.map(serialize).join('');
}

export const sourceTableUnavailable = '此表格包含目前無法完整呈現的格式，請開啟原始資料核對；未將它轉成可能錯置欄位的文字表格。';
