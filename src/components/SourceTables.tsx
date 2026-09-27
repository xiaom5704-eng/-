import { createElement } from 'react';
import { sourceTableNodes, sourceTableUnavailable, type SourceTableNode } from '../../shared/label-tables';

const renderNode = (node: SourceTableNode, key: number) => node.type === 'text' ? node.value :
  createElement(node.tagName, { ...node.properties, key }, ...node.children.map(renderNode));

export default function SourceTables({ tables }: { tables: string[] }) {
  return <div className="space-y-4 mt-4">
    <p className="text-xs text-slate-600">原始資料表格（英文）；請一併閱讀本段文字與註記。僅供來源核對，不是個人用藥建議。</p>
    {tables.map((html, index) => {
      const nodes = sourceTableNodes(html);
      return nodes ? <div key={index} className="source-table" role="region" aria-label={`仿單原文表格 ${index + 1}，可左右捲動`} tabIndex={0}>{nodes.map(renderNode)}</div> :
        <p key={index} className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">{sourceTableUnavailable}</p>;
    })}
  </div>;
}
