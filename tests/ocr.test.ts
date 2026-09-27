import { test } from 'node:test';
import assert from 'node:assert/strict';
import { combineOcrLines, ocrImageSize, ocrLines, ocrRegions, ocrReviewLines, observationFromOcr, switchOcrReading, withEnlargedReading, type OcrPage } from '../shared/medication-ocr';
import { readMedicationScan, type LocalOcrOptions } from '../src/services/medication-scan';
import { readLocalMedicationFiles } from '../src/services/medication-ocr';

const files = [{ name: 'synthetic.png', data: 'data:image/png;base64,AA==' }];
const options = (): LocalOcrOptions => ({ target: 'label', signal: new AbortController().signal, onProgress: () => {} });

test('Local OCR receives files without an API key and never invokes the cloud reader', async () => {
  let calls = 0;
  const pages = [{ fileName: files[0].name, page: 1, text: 'Synthetic Tablet 2.5 mg', confidence: 80 }];
  const result = await readMedicationScan('local', files, '', options(), {
    local: async (input, config) => { assert.deepEqual(input, files); assert.equal(config.target, 'label'); return pages; },
    gemini: async () => { calls++; throw new Error('Unexpected upload'); },
  });
  assert.deepEqual(result, { engine: 'local', pages }); assert.equal(calls, 0);
});

test('A local OCR failure or pre-cancellation never falls back to Gemini', async () => {
  let cloudCalls = 0, localCalls = 0;
  const dependencies = { local: async () => { localCalls++; throw new Error('Local engine unavailable'); }, gemini: async () => { cloudCalls++; return []; } };
  await assert.rejects(readMedicationScan('local', files, 'synthetic-key', options(), dependencies), /Local engine unavailable/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(readMedicationScan('local', files, '', { ...options(), signal: controller.signal }, dependencies), { name: 'AbortError' });
  assert.equal(localCalls, 1); assert.equal(cloudCalls, 0);
});

test('Only explicit Gemini selection sends file data to the cloud reader', async () => {
  let calls = 0;
  const observations = [observationFromOcr('Synthetic Tablet', 'label')];
  const result = await readMedicationScan('gemini', files, 'synthetic-key', options(), {
    local: async () => { throw new Error('Wrong reader'); },
    gemini: async (data, key) => { calls++; assert.deepEqual(data, [files[0].data]); assert.equal(key, 'synthetic-key'); return observations; },
  });
  assert.deepEqual(result, { engine: 'gemini', observations }); assert.equal(calls, 1);
});

test('OCR review retains full lines, strengths and ambiguous characters without guessing identities', () => {
  assert.deepEqual(ocrLines('測 試 藥 品 2.5 mg\r\nＦＹ Ｔ０６１\nAB/25\nO0 I1\nAB/25'), ['測試藥品 2.5 mg', 'FY T061', 'AB/25', 'O0 I1']);
  assert.deepEqual(observationFromOcr('FY T061', 'pill'), { name: '', strength: '', dosageForm: '', appearance: { shape: '', color: '', imprints: ['FY T061'] } });
  assert.deepEqual(observationFromOcr('Synthetic Tablet 2.5 mg', 'label'), { name: 'Synthetic Tablet 2.5 mg', strength: '', dosageForm: '' });
  assert.throws(() => observationFromOcr('one\ntwo', 'pill'));
  assert.throws(() => observationFromOcr('x'.repeat(121), 'label'));
  assert.throws(() => observationFromOcr('', 'pill'));
});

test('Local OCR rejects missing, excessive and non-image input before starting an engine', async () => {
  await assert.rejects(readLocalMedicationFiles([], options()), /1–4/);
  await assert.rejects(readLocalMedicationFiles(Array.from({ length: 5 }, () => files[0]), options()), /1–4/);
  await assert.rejects(readLocalMedicationFiles([{ name: 'test.html', data: 'data:text/html;base64,AA==' }], options()), /僅支援/);
  await assert.rejects(readLocalMedicationFiles([{ name: 'test.png', data: 'https://untrusted.example/image.png' }], options()), /僅支援/);
});

test('User-selected label fragments preserve order, dosage decimals and ambiguous characters', () => {
  assert.equal(combineOcrLines(['伏冒', '普拿疼', '加強锭']), '伏冒 普拿疼 加強锭');
  assert.equal(combineOcrLines(['Test 1.5 mg', 'O0 I1']), 'Test 1.5 mg O0 I1');
  for (const lines of [[], ['one'], ['one\ntwo', 'three'], ['one', ' '], Array(7).fill('part'), ['a'.repeat(120), 'b']])
    assert.throws(() => combineOcrLines(lines));
});

test('Selected imprint lines preserve repeated characters and uncertainty within the receiving field limit', () => {
  assert.deepEqual(ocrLines('SK\nKBT\n10\n10', 'pill'), ['SK', 'KBT', '10', '10']);
  assert.equal(combineOcrLines(['SK', 'KBT'], 'pill'), 'SK KBT');
  assert.equal(combineOcrLines(['10', '10'], 'pill'), '10 10');
  assert.equal(combineOcrLines(['FC', '16'], 'pill'), 'FC 16', 'do not replace a plausible OCR error with a known database imprint');
  assert.equal(combineOcrLines([' O0 ', ' I1 '], 'pill', 80), 'O0 I1');
  assert.throws(() => combineOcrLines(['a'.repeat(79), 'b'], 'pill', 80), /80/);
  for (const limit of [0, 121, NaN]) assert.throws(() => combineOcrLines(['A', 'B'], 'pill', limit));
});

test('Pill close-ups retain native pixels while label upscaling and large-image bounds remain intact', () => {
  assert.deepEqual(ocrImageSize(224, 224, 'pill'), { width: 224, height: 224 });
  assert.deepEqual(ocrImageSize(408, 169, 'label'), { width: 1280, height: 530 });
  assert.deepEqual(ocrImageSize(4000, 3000, 'pill'), { width: 1280, height: 960 });
  assert.deepEqual(ocrImageSize(3000, 4000, 'label'), { width: 1800, height: 2400 });
  for (const [width, height] of [[0, 20], [20, -1], [NaN, 20], [20, Infinity]]) assert.throws(() => ocrImageSize(width, height, 'pill'));
});

test('Identical pill and ruler digits retain distinct photo locations', () => {
  const text = 'FC\n10\n10';
  const regions = ocrRegions([
    { text: 'FC', poly: [[20, 10], [40, 10], [40, 20], [20, 20]] },
    { text: '10', poly: [[20, 25], [40, 25], [40, 35], [20, 35]] },
    { text: '10', poly: [[160, 80], [180, 80], [180, 90], [160, 90]] },
  ], 200, 100);
  const page: OcrPage = { fileName: 'test.png', page: 1, text, confidence: 90, layout: { image: 'data:image/jpeg;base64,test', text, regions } };
  const lines = ocrReviewLines(page, 'pill');
  assert.deepEqual(lines.map(line => line.text), ['FC', '10', '10']);
  assert.deepEqual(lines[1].boxes, [{ left: 10, top: 25, width: 10, height: 10 }]);
  assert.deepEqual(lines[2].boxes, [{ left: 80, top: 80, width: 10, height: 10 }]);
  assert.equal(combineOcrLines(lines.slice(0, 2).map(line => line.text), 'pill'), 'FC 10');
});

test('Edited text cannot inherit old position evidence even when it becomes a plausible imprint', () => {
  const page: OcrPage = { fileName: 'test.png', page: 1, text: 'FC\n16', confidence: 99,
    layout: { image: 'data:image/jpeg;base64,test', text: 'FC\n16', regions: [{ line: 1, box: { left: 10, top: 20, width: 20, height: 10 } }] } };
  assert.equal(ocrReviewLines(page, 'pill')[1].boxes.length, 1);
  for (const text of ['FC\n10', '16\nFC', 'FC 16', 'FC\n\n16']) {
    assert.ok(ocrReviewLines({ ...page, text }, 'pill').every(line => line.boxes.length === 0));
  }
  assert.equal(page.layout.text, 'FC\n16');
  assert.deepEqual(ocrReviewLines({ ...page, layout: undefined }, 'pill').map(line => line.text), ['FC', '16']);
});

test('Label normalization retains all matching regions without shifting blank or multiline entries', () => {
  const text = ' 測 試 \n\nＡＢ\r\n測試';
  const regions = ocrRegions([
    { text: ' 測 試 ', poly: [[0, 0], [20, 0], [20, 10]] },
    { text: '\nＡＢ\r\n測試 ', poly: [[40, 50], [60, 50], [60, 70]] },
  ], 100, 100);
  // The reader joins trimmed OCR entries; blank lines in edited text invalidate positions.
  const original = '測 試\nＡＢ\r\n測試';
  const page: OcrPage = { fileName: 'test.png', page: 1, text: original, confidence: 80,
    layout: { image: 'data:image/jpeg;base64,test', text: original, regions } };
  const lines = ocrReviewLines(page, 'label');
  assert.deepEqual(lines.map(line => line.text), ['測試', 'AB']);
  assert.equal(lines[0].boxes.length, 2);
  assert.equal(lines[1].boxes[0].top, 50);
  assert.ok(ocrReviewLines({ ...page, text }, 'label').every(line => !line.boxes.length));
});

test('Invalid or outside OCR polygons never create misleading image regions', () => {
  const items: Parameters<typeof ocrRegions>[0] = [
    { text: 'empty', poly: [] },
    { text: 'invalid', poly: [[NaN, 0], [10, 0], [10, 10]] },
    { text: 'outside', poly: [[120, 120], [130, 120], [130, 130]] },
    { text: 'partial', poly: [[-10, -10], [20, 0], [20, 10]] },
  ];
  assert.deepEqual(ocrRegions(items, 100, 100), [{ line: 3, box: { left: 0, top: 0, width: 20, height: 10 } }]);
  assert.deepEqual(ocrRegions(items, 0, 100), []);
  assert.deepEqual(ocrRegions(items, Infinity, 100), []);
});

test('An enlarged reading cannot overwrite a contradictory original or combine its ruler digits', () => {
  const original: OcrPage = { fileName: 'test.png', page: 1, text: 'APO\n10', confidence: 80,
    layout: { image: 'data:image/jpeg;base64,test', text: 'APO\n10', regions: [{ line: 0, box: { left: 20, top: 20, width: 10, height: 5 } }] } };
  const enlarged = { text: 'APG\n10\n10', confidence: 99,
    layout: { image: 'data:image/jpeg;base64,test', text: 'APG\n10\n10', regions: [{ line: 0, box: { left: 21, top: 20, width: 11, height: 5 } }] } };
  const page = withEnlargedReading(original, enlarged);
  assert.equal(page.text, 'APO\n10', 'higher aggregate confidence does not select a different glyph');
  const other = switchOcrReading(page);
  assert.equal(other.text, 'APG\n10\n10');
  assert.equal(other.reading, 'enlarged');
  assert.deepEqual(ocrReviewLines(other, 'pill').map(line => line.text), ['APG', '10', '10']);
  assert.equal(ocrReviewLines(other, 'pill')[0].boxes[0].left, 21);
  assert.deepEqual(switchOcrReading(other), page);
});

test('Switching OCR readings preserves human edits but never restores stale geometry for them', () => {
  const original: OcrPage = { fileName: 'test.png', page: 1, text: 'FC\n16', confidence: 99,
    layout: { image: 'data:image/jpeg;base64,test', text: 'FC\n16', regions: [{ line: 1, box: { left: 10, top: 20, width: 20, height: 10 } }] } };
  const edited = { ...withEnlargedReading(original, { text: 'FC\n10', confidence: 90 }), text: 'FC\n10 corrected by human' };
  const other = switchOcrReading(edited);
  assert.equal(other.layout, undefined, 'a reading without positions cannot inherit another reading geometry');
  const restored = switchOcrReading({ ...other, text: 'FC\n10 second edit' });
  assert.equal(restored.text, edited.text);
  assert.equal(restored.alternative.text, 'FC\n10 second edit');
  assert.ok(ocrReviewLines(restored, 'pill').every(line => !line.boxes.length));
});

test('Empty enlargement preserves native close-up text; only an empty native reading yields the initial view', () => {
  const original: OcrPage = { fileName: 'crop.png', page: 1, text: 'C', confidence: 97 };
  assert.equal(withEnlargedReading(original, { text: ' ', confidence: 0 }), original);
  assert.equal(switchOcrReading(original), original);
  const recovered = withEnlargedReading({ ...original, text: '', confidence: 0 }, { text: 'FC\n10', confidence: 80 });
  assert.equal(recovered.reading, 'enlarged');
  assert.equal(recovered.text, 'FC\n10');
  assert.equal(recovered.alternative.text, '');
  assert.equal(recovered.fileName, 'crop.png');
  assert.equal(recovered.page, 1, 'two passes still represent one source page');
});
