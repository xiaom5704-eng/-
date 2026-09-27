import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { sourceTableHtml, sourceTableNodes } from '../shared/label-tables';
import { reportToMarkdown, type MedicationReport } from '../shared/medication';
import SourceTables from '../src/components/SourceTables';
import MarkdownContent from '../src/components/MarkdownContent';
import { parseLabelPage, labelContext, readLabelSnapshot } from '../server/medications/label-registry';
import { DrugProviders } from '../server/medications/providers';
import { openDrugDatabase } from '../server/medications/store';

const table = '<table><caption>SYNTHETIC comparison</caption><thead><tr><th rowspan="2" scope="col">Condition</th><th colspan="2">Measurements</th></tr><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td rowspan="0">Group</td><td><paragraph><content styleCode="bold">1 &lt; 2</content></paragraph><paragraph>Second line<br/>Last qualifier</paragraph></td><td>10<sup>−3</sup></td></tr><tr><td>NA</td><td>x<sub>2</sub></td></tr></tbody><tfoot><tr><td colspan="3">*SYNTHETIC footnote</td></tr></tfoot></table>';
const render = (tables = [table]) => renderToStaticMarkup(createElement(SourceTables, { tables }));
const source = () => ({ id: 'synthetic-tables', set_id: 'synthetic-set', version: '1', effective_time: '20260922', openfda: { substance_name: ['ALPHA'], brand_name: ['SYNTHETIC'] },
  warnings: ['SYNTHETIC qualifier before and after the table.'], warnings_table: [table], pediatric_use_table: ['<table><tr><td>SYNTHETIC child text</td><td>Review</td></tr></table>'] });
const ingredients = [{ original: 'ALPHA', name: 'alpha', rxCui: '1', mapping: 'rxnorm' as const }];
const response = (record: unknown) => new Response(JSON.stringify({ results: [record] }), { headers: { 'Content-Type': 'application/json' } });

test('Source table rendering retains merged cells, row groups, captions, emphasis, footnotes and scientific notation', () => {
  const html = render();
  for (const expected of ['rowSpan="2"', 'colSpan="2"', 'rowSpan="0"', '<thead>', '<tbody>', '<tfoot>', '<caption>', '<strong>1 &lt; 2</strong>', '<sup>−3</sup>', '<sub>2</sub>', 'Last qualifier', '*SYNTHETIC footnote']) assert.ok(html.includes(expected), expected);
  assert.match(html, /role="region".*tabindex="0"/);
  const canonical = sourceTableHtml(table)!;
  assert.deepEqual(sourceTableNodes(canonical), sourceTableNodes(table));
});

test('Only inert markup and validated spans reach the page; unsupported source content remains explicit', () => {
  const safe = sourceTableHtml('<table onclick="alert(1)" style="background:url(https://example.test)"><tr><td onmouseover="alert(2)"><a href="javascript:alert(3)">Footnote</a>&lt;script&gt;text&lt;/script&gt;</td></tr></table>')!;
  assert.ok(safe); assert.doesNotMatch(safe, /onclick|onmouseover|javascript:|background|https:|<script/i);
  assert.match(safe, /Footnote/); assert.match(safe, /&lt;script&gt;/);
  for (const invalid of ['<table><tr><td><img src="https://example.test/formula.png"></td></tr></table>', '<table><tr><td><script>alert(1)</script></td></tr></table>',
    '<table><tr><td colspan="-1">unsafe span</td></tr></table>', '<table><tr><td rowspan="1000000">huge</td></tr></table>', '<table></table>outside text', '<table><tr><td>\0</td></tr></table>', 'x'.repeat(512001)]) {
    assert.equal(sourceTableNodes(invalid), undefined);
    const rendered = render([invalid]); assert.match(rendered, /無法完整呈現/); assert.doesNotMatch(rendered, /<img|<script/);
  }
});

test('Saved report Markdown preserves the same table relationships without enabling arbitrary HTML', () => {
  const labels = parseLabelPage({ results: [source()] }, [['alpha']]);
  const report: MedicationReport = { checkedAt: '2026-09-22', datasets: [], limitations: [], interactions: [], medications: [{
    drug: { source: 'tfda', id: 'SYNTHETIC', name: '合成測試', englishName: '', ingredients: ['ALPHA'], dosageForm: '', manufacturer: '', licenseStatus: '', validUntil: '', indications: '', dosageText: '', sourceUrl: 'https://example.test' },
    ingredients, labels, labelStatus: 'found', warnings: [],
  }] };
  const markdown = reportToMarkdown(report);
  assert.match(markdown, /<table>/); assert.match(markdown, /rowspan="2"/);
  const html = renderToStaticMarkup(createElement(MarkdownContent, { children: markdown + '\n\n<script>alert(99)</script>' }));
  for (const expected of ['<table>', 'rowSpan="2"', 'colSpan="2"', 'rowSpan="0"', '<sup>−3</sup>', '*SYNTHETIC footnote', 'SYNTHETIC child text']) assert.ok(html.includes(expected), expected);
  assert.doesNotMatch(html, /<script|alert\(99\)|&lt;table/);
  assert.equal(labels[0].sections.find(section => section.title === '兒童使用資訊')!.text, '');
});

test('Version 2 snapshots gain original tables offline without a temporary API cache or a new acquisition date', async () => {
  const db = openDrugDatabase(':memory:');
  try {
    const context = labelContext(ingredients)!;
    await new DrugProviders(db, (async () => response(source())) as typeof fetch).labels(ingredients);
    const saved = readLabelSnapshot(db, context)!;
    const legacy = { ...saved, tableVersion: undefined, labels: parseLabelPage({ results: [source()] }, context.groups, false) };
    db.prepare('UPDATE label_registry SET payload=? WHERE key=?').run(JSON.stringify(legacy), context.key);
    db.exec('DELETE FROM drug_api_cache');
    let calls = 0;
    const provider = new DrugProviders(db, (async () => { calls++; throw new Error('network forbidden'); }) as typeof fetch);
    const offline = await provider.labels(ingredients, 'local');
    assert.equal(calls, 0); assert.equal(offline.lookup!.retrievedAt, saved.retrievedAt);
    assert.equal(offline.lookup!.refresh, 'not_requested'); assert.deepEqual(offline.labels, saved.labels);
    assert.equal(readLabelSnapshot(db, context)!.tableVersion, 1);
    assert.equal('rawLabels' in offline.lookup!, false); assert.equal('tableVersion' in offline.lookup!, false);
  } finally { db.close(); }
});

test('Invalid table response preserves previously verified text and tables', async () => {
  const db = openDrugDatabase(':memory:');
  try {
    await new DrugProviders(db, (async () => response(source())) as typeof fetch).labels(ingredients);
    const saved = readLabelSnapshot(db, labelContext(ingredients)!)!;
    db.exec('DELETE FROM drug_api_cache');
    const failed = await new DrugProviders(db, (async () => response({ ...source(), warnings_table: [123] })) as typeof fetch).labels(ingredients);
    assert.equal(failed.lookup!.refresh, 'failed'); assert.deepEqual(failed.labels, saved.labels);
    // A known table-only section and a new source field must both remain discoverable.
    const other = parseLabelPage({ results: [{ ...source(), future_field_table: ['<table><tr><td>New source section</td></tr></table>'] }] }, [['alpha']]);
    assert.ok(other[0].sections.some(section => section.title === '其他來源表格：future_field' && section.tables?.length === 1));
  } finally { db.close(); }
});
