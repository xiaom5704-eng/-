import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import MarkdownContent from '../src/components/MarkdownContent';
import { reportToMarkdown, type MedicationReport } from '../shared/medication';
import { summarizeMedicationReport } from '../shared/medication-summary';
import { safetySources } from '../shared/medication-safety';

const render = (children: string, inverse = false) => renderToStaticMarkup(createElement(MarkdownContent, { children, inverse }));

const sourceReport: MedicationReport = {
  checkedAt: '2026-09-22T00:00:00.000Z', datasets: [], medications: [], interactions: [], limitations: [],
  safety: { patient: { age: { value: '1', unit: 'months' }, premature: 'unknown' }, reviewedAt: '2026-09-20',
    alerts: [{ id: 'test-source', kind: 'missing', title: '測試來源', detail: '合成報告，不是病人資料', drugNames: [],
      sources: [safetySources.fencaine, { title: 'Synthetic source', url: 'https://example.test/繁體 名稱(參考).pdf?value=50%25', version: 'test', scope: 'test' }] }],
    uncoveredDrugNames: [], limitations: [] },
};

test('Saved reports and summaries preserve encoded source URLs, Unicode, spaces and parentheses', () => {
  for (const markdown of [reportToMarkdown(sourceReport), summarizeMedicationReport(sourceReport)]) {
    const markup = render(markdown);
    assert.ok(markup.includes(`href="${new URL(safetySources.fencaine.url).href}"`));
    assert.doesNotMatch(markup, /Strocaine%2520|value=50%2525/);
    assert.ok(markup.includes('value=50%25'));
    assert.equal((markup.match(/<a href=/g) || []).length, 2);
  }
});

test('Age-related reports have no empty confirmed-products heading before safety content', () => {
  const report = reportToMarkdown(sourceReport);
  assert.doesNotMatch(report, /### 已確認的藥品/);
  assert.match(report, /### 年齡與併用提醒/);
  assert.match(report, /### 藥品明細/);
  assert.match(reportToMarkdown({ ...sourceReport, safety: undefined }), /### 已確認的藥品/);
});

test('Answers render GFM tables, emphasis and safe cell line breaks instead of raw markup', () => {
  const markup = render('### 查詢重點\n\n| 項目 | 說明 |\n| :--- | :--- |\n| **測試項目**<br>補充說明 | 第一行<br/>第二行<BR />最終限制條件 |');
  assert.match(markup, /<table>/);
  assert.match(markup, /<th[^>]*>項目<\/th>/);
  assert.match(markup, /<strong>測試項目<\/strong><br\/>\s*補充說明/);
  assert.match(markup, /第一行<br\/>\s*第二行<br\/>\s*最終限制條件/);
  assert.doesNotMatch(markup, /&lt;br|:---|\| 項目/);
  assert.match(markup, /role="region".*tabindex="0"/);
});

test('Rendering does not enable raw HTML, handlers or unsafe URLs', () => {
  const markup = render('前文<br>後文 <img src=x onerror="alert(1)"> <br onclick="alert(1)">\n\n<script>alert(1)</script>\n\n[測試](javascript:alert%281%29)');
  assert.match(markup, /前文<br\/>\s*後文/);
  assert.doesNotMatch(markup, /<script|<img|onclick|onerror|javascript:|alert\(1\)/i);
});

test('Code, escaped tags and source content remain literal while normal lists stay semantic', () => {
  const markup = render('`<br>`\n\n```html\n<br>\n```\n\n&lt;br&gt;\n\n- 第一點\n- 第二點\n\n最後的限制條件。');
  assert.match(markup, /<code>&lt;br&gt;<\/code>/);
  assert.match(markup, /<pre><code class="language-html">&lt;br&gt;/);
  assert.match(markup, /<p>&lt;br&gt;<\/p>/);
  assert.match(markup, /<li>第一點<\/li>/);
  assert.match(markup, /最後的限制條件。/);
  assert.match(render('**使用者的問題**', true), /prose-invert/);
});
