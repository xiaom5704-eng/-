import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Ref } from 'react';
import { sourceTableNodes } from '../../shared/label-tables';
import { isLocalDocumentPath } from '../../shared/source-document';
import { SourceDocumentLink } from './SourceDocument';

type MarkdownNode = { type: string; value?: string; children?: MarkdownNode[]; data?: unknown };

// Convert only standalone, attribute-free HTML line breaks. Keep code nodes
// literal. Source tables are separately rebuilt as inert nodes; all other HTML
// remains subject to ReactMarkdown's skipHtml handling.
function remarkLineBreaks() {
  return (tree: MarkdownNode) => {
    const visit = (node: MarkdownNode) => {
      if (!node.children) return;
      node.children = node.children.flatMap(child => {
        if (child.type === 'html' && /^\s*<table[\s>]/i.test(child.value || '')) {
          const tables = sourceTableNodes(child.value!);
          if (tables) return [{ type: 'sourceTable', data: { hName: 'div', hChildren: tables } }];
        }
        if (child.type === 'html' && /^(?:<br\s*\/?>\s*)+$/i.test(child.value || '')) {
          return Array.from({ length: child.value!.match(/<br\s*\/?>/gi)!.length }, () => ({ type: 'break' }));
        }
        visit(child);
        return [child];
      });
    };
    visit(tree);
  };
}

export default function MarkdownContent({ children, inverse = false, contentRef }: { children: string; inverse?: boolean; contentRef?: Ref<HTMLDivElement> }) {
  return <div ref={contentRef} className={`markdown-content prose prose-slate max-w-none${inverse ? ' prose-invert' : ''}`}>
    <ReactMarkdown remarkPlugins={[remarkGfm, remarkLineBreaks]} skipHtml components={{
      a: ({ node: _node, href, children, ...props }) => href && isLocalDocumentPath(href)
        ? <SourceDocumentLink href={href}>{children}</SourceDocumentLink> : <a href={href} {...props}>{children}</a>,
      table: ({ children }) => <div className="markdown-table" role="region" aria-label="回答內容表格，可左右捲動" tabIndex={0}><table>{children}</table></div>,
    }}>{children}</ReactMarkdown>
  </div>;
}
