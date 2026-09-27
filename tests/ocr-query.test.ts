import { test } from 'node:test';
import assert from 'node:assert/strict';
import { suggestOcrQuery } from '../shared/ocr-query';
import { ocrLines, observationFromOcr } from '../shared/medication-ocr';
import { openDrugDatabase } from '../server/medications/store';
import { importTfda } from '../server/medications/importers';
import { matchObservation } from '../server/medications/appearance';

test('OCR query suggestions retain names and strengths while exposing excluded field text', () => {
  const cases = [
    ['藥名：Somin 2mg 用法：測試文字', 'Somin 2mg', '藥名:', '用法:測試文字'],
    ['藥品名稱：Cypromin 0.4mg/mL 數量：測試文字', 'Cypromin 0.4mg/mL', '藥品名稱:', '數量:測試文字'],
    ['品名：普拿疼膜衣錠500毫克 包裝數量：16錠', '普拿疼膜衣錠500毫克', '品名:', '包裝數量:16錠'],
    ['Fencaine 10mg 每次1錠 每日3次', 'Fencaine 10mg', '', '每次1錠 每日3次'],
    ['ALPHA 1mg | QTY: 20', 'ALPHA 1mg', '', '| QTY: 20'],
  ];
  for (const [line, query, prefix, suffix] of cases) assert.deepEqual(suggestOcrQuery(line), { query, prefix, suffix });
  const normalized = ocrLines('品名：普 拿 疼 膜 衣 錠500毫克 包裝數量：16錠')[0];
  assert.equal(suggestOcrQuery(normalized)?.query, '普拿疼膜衣錠500毫克');
});

test('Query extraction never corrects glyphs, converts measurements or treats trailing dose fields as strengths', () => {
  for (const name of ['O0 I1 1.5mg', 'ALPHA 1/2mg', 'ALPHA 1-5mg', 'ALPHA 1,000mg', 'ALPHA 0.4mg/5mL', 'ALPHA 0.5%', 'ALPHA 1mg / 1mL']) {
    const text = `藥名：${name} 劑量：2mg 每日3次`;
    assert.equal(suggestOcrQuery(text)?.query, name);
    assert.equal(suggestOcrQuery(text)?.suffix, '劑量:2mg 每日3次');
  }
  assert.equal(suggestOcrQuery('藥名：ＡＬＰＨＡ ０．４mg／mL 用法：測試')?.query, 'ALPHA 0.4mg/mL');
});

test('Unmarked text, multiple labelled drugs, multiline input and incomplete boundaries require manual review', () => {
  for (const text of ['普拿疼 伏冒 加強錠', 'SK KBT', 'ALPHA 10mg BID', 'ALPHA 每日錠',
    '藥名：A', '藥名： 用法：測試', '用法：測試文字', '藥名：ALPHA\n藥名：BETA',
    '藥名：ALPHA 用法：測試 藥名：BETA', '姓名：測試 藥名：ALPHA',
    `藥名：${'A'.repeat(121)}`, `藥名：ALPHA 用法：${'A'.repeat(1000)}`]) assert.equal(suggestOcrQuery(text), undefined, text);
  assert.equal(suggestOcrQuery(`藥名：ALPHA 1mg 用法：${'測試'.repeat(80)}`)?.query, 'ALPHA 1mg', 'a long field can be reviewed without truncating the drug name');
});

test('Reviewed query reaches real local matching and retains its written specification', t => {
  const db = openDrugDatabase(':memory:'); t.after(() => db.close());
  importTfda(db, ['1mg', '2mg', '0.4mg/mL', '0.4mg/5mL'].map((strength, index) => ({
    許可證字號: `SYNTHETIC${index}`, 中文品名: `人工測試${strength}`, 英文品名: `ALPHA ${strength}`, 主成分略述: 'Synthetic Ingredient', 劑型: '錠劑',
  })));
  const original = '藥名：ALPHA 1mg 劑量：2mg 每日3次';
  assert.equal(matchObservation(db, observationFromOcr(original, 'label')).total, 0);
  const suggestion = suggestOcrQuery(original)!;
  assert.deepEqual(matchObservation(db, observationFromOcr(suggestion.query, 'label')).candidates.map(d => d.id), ['SYNTHETIC0']);
  assert.deepEqual(matchObservation(db, observationFromOcr(suggestOcrQuery('品名：ALPHA 0.4mg/mL QTY: 100mL')!.query, 'label')).candidates.map(d => d.id), ['SYNTHETIC2']);
});
