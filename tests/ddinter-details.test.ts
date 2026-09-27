import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { openDrugDatabase, type DrugDatabase } from '../server/medications/store';
import { importDdinterGraph } from '../server/medications/ddinter-supplements';
import { parseDdinterDetail, importDdinterDetail, readDdinterDetail, validateDdinterDetailArchive } from '../server/medications/ddinter-details';
import { DrugProviders } from '../server/medications/providers';
import { escapeMarkdown, reportToMarkdown, type DrugCandidate } from '../shared/medication';
import MedicationInteractions from '../src/components/MedicationInteractions';

const source = readFileSync(new URL('./fixtures/ddinter/270023.html', import.meta.url), 'utf8');
const date = '2026-09-23T00:00:00.000Z';
const hash = (raw: string) => createHash('sha256').update(raw).digest('hex');
const opened: DrugDatabase[] = [];
afterEach(() => opened.splice(0).forEach(db => db.close()));
function database() { const db = openDrugDatabase(':memory:'); opened.push(db); return db; }
function graph(db: DrugDatabase, level = 'Moderate', name = 'Dexchlorpheniramine') {
  importDdinterGraph(db, JSON.stringify({ info: { id: 'DDInter1996', Name: name }, interactions: [{ id: 'DDInter459', name: 'Cyproheptadine', level: [level] }] }), 'DDInter1996', date);
}
function fixture() { const db = database(); graph(db); importDdinterDetail(db, source, '270023', date); return db; }
const read = (db: DrugDatabase) => readDdinterDetail(db, 'DDInter1996', 'DDInter459', 'Moderate');
const product = (name: string): DrugCandidate => ({ source: 'tfda', id: name, name, englishName: name, ingredients: [name],
  dosageForm: '', manufacturer: '', licenseStatus: '', validUntil: '', indications: '', dosageText: '', sourceUrl: 'https://data.gov.tw/dataset/9122' });

test('Official source fragment preserves exact pair, paragraphs and all references; page chrome does not affect reviewed content', () => {
  const parsed = parseDdinterDetail(source);
  assert.deepEqual(parsed.drugIds, ['DDInter1996', 'DDInter459']);
  assert.deepEqual(parsed.drugNames, ['Dexchlorpheniramine', 'Cyproheptadine']);
  assert.equal(parsed.level, 'Moderate');
  assert.equal(parsed.references.length, 15);
  assert.equal(parsed.contentSha256, '975f43d327b4707b89cd45ef24b6d644ef9521decdceea80907532cfdb3249c6');
  assert.ok(parsed.interaction.endsWith('torsade de pointes and sudden death.'));
  assert.ok(parsed.management.endsWith('if excessive adverse effects develop.'));
  assert.deepEqual(parseDdinterDetail(source.replace('</main>', '<script>fetch("https://example.invalid")</script></main>')), parsed);
});

test('Missing, ambiguous, oversized, malformed or substituted source fields are rejected before overwriting data', () => {
  const db = fixture(), before = db.prepare('SELECT * FROM ddinter_pair_details').all();
  for (const raw of ['', '<html>Login required</html>', ' '.repeat(2_000_001), source + '\0',
    source.replace('>Interaction</td>', '>Details</td>'), source.replace('>Management</td>', '>Interaction</td>'),
    source.replace('>Moderate</span>', '>Severe</span>'), source.replace('href="/server/drug-detail/DDInter459/"', 'href="https://untrusted.invalid/"'),
    source.replace('Cyproheptadine', 'Unrelated'), source.replace('>Moderate</span>', '>Minor</span>')])
    assert.throws(() => importDdinterDetail(db, raw, '270023', date));
  for (const id of ['../270023', '0', '', '270023/']) assert.throws(() => importDdinterDetail(db, source, id, date));
  assert.throws(() => importDdinterDetail(db, source, '270023', 'yesterday'));
  assert.deepEqual(db.prepare('SELECT * FROM ddinter_pair_details').all(), before);
});

test('Archive import checks source, hash, date and format instead of trusting saved metadata', () => {
  const archive = { schema: 1, id: '270023', retrievedAt: date, sourceUrl: 'https://ddinter2.scbdd.com/server/interact/270023/', sha256: hash(source), raw: source };
  assert.deepEqual(validateDdinterDetailArchive(archive), archive);
  for (const bad of [null, {}, { ...archive, raw: source + ' ' }, { ...archive, id: '1' }, { ...archive, schema: 2 },
    { ...archive, retrievedAt: 'invalid' }, { ...archive, sourceUrl: 'https://untrusted.invalid' }])
    assert.throws(() => validateDdinterDetailArchive(bad));
});

test('Detail import cannot create or upgrade a pair; later graph level/name changes suppress incompatible historical details', () => {
  const db = database();
  assert.throws(() => importDdinterDetail(db, source, '270023', date), /不符/);
  graph(db); importDdinterDetail(db, source, '270023', date);
  assert.ok(read(db)?.summary);
  assert.throws(() => importDdinterDetail(db, source, '999999', date)); // same pair under another page ID
  graph(db, 'Major'); assert.equal(read(db), undefined);
  assert.equal(readDdinterDetail(db, 'DDInter1996', 'DDInter459', 'Major'), undefined);
  graph(db, 'Moderate', 'Unrelated'); assert.equal(read(db), undefined);
  graph(db); assert.ok(read(db)?.summary);
  assert.equal(db.prepare('SELECT * FROM ddinter_pair_details').all().length, 1);
});

test('Source revision keeps new original text but removes the now-unreviewed Chinese explanation', () => {
  const db = fixture(), previous = read(db)!;
  const changed = source.replace('Caution is advised', 'Additional caution is advised');
  importDdinterDetail(db, changed, '270023', '2026-09-24T00:00:00Z');
  assert.equal(read(db)?.summary, undefined);
  assert.ok(read(db)?.management.startsWith('Additional caution'));
  assert.notEqual(read(db)?.contentSha256, previous.contentSha256);
  assert.equal(previous.summary?.reviewedAt, '2026-09-23');
});

test('Offline report, saved Markdown and readable UI retain original evidence and escape source markup', async () => {
  const db = fixture(); let external = 0;
  const provider = new DrugProviders(db, async () => { external++; throw Error('Unexpected external request'); });
  const report = await provider.report([product('Cyproheptadine'), product('Dexchlorpheniramine')], 'local');
  assert.equal(external, 0);
  assert.equal(report.interactions[0].status, 'found');
  assert.ok(report.interactions[0].detail?.summary);
  const markdown = reportToMarkdown(report);
  assert.ok(markdown.includes('專案依來源整理'));
  assert.ok(markdown.includes(escapeMarkdown(date)));
  assert.ok(markdown.includes(escapeMarkdown(read(db)!.references[14])));
  const html = renderToStaticMarkup(createElement(MedicationInteractions, { report }));
  assert.ok(html.includes('鎮靜作用也可能疊加'));
  assert.ok(html.includes('閱讀已保存的來源原文'));
  assert.ok(!html.includes('尚未保存詳細原因'));
  const snapshot = JSON.stringify(report);
  graph(db, 'Major');
  assert.equal(JSON.stringify(report), snapshot); // already returned report is immutable history
  report.interactions[0].detail!.interaction = '<script>alert(1)</script> **not bold**';
  assert.ok(reportToMarkdown(report).includes(escapeMarkdown(report.interactions[0].detail!.interaction)));
  const escapedHtml = renderToStaticMarkup(createElement(MedicationInteractions, { report }));
  assert.ok(!escapedHtml.includes('<script>'));
  assert.ok(escapedHtml.includes('&lt;script&gt;'));
  delete report.interactions[0].detail;
  assert.ok(renderToStaticMarkup(createElement(MedicationInteractions, { report })).includes('尚未保存詳細原因'));
});
