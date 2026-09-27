import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifiedProductLabel } from '../server/medications/verified-names';

// All six source ingredients were checked against TFDA's product page and PDF.
const product = { source: 'tfda' as const, id: '衛署藥輸字第023784號', ingredients: [
  'PHENYLEPHRINE HCL', 'CAFFEINE ANHYDROUS', 'ASCORBIC ACID (COATED)',
  'NOSCAPINE', 'TERPIN HYDRATE', 'ACETAMINOPHEN FINE',
] };

test('The complete six-ingredient Cold Extra product has a reviewed Taiwan label', () => {
  assert.equal(verifiedProductLabel(product)?.sourceUrl, 'https://mcp.fda.gov.tw/insert/pdfcasefile/i_3534897f-e297-46cb-8114-0020ad10496c');
  assert.match(verifiedProductLabel(product)!.title, /歷史仿單.*2021/);
  assert.deepEqual(verifiedProductLabel({ ...product, ingredients: [...product.ingredients].reverse() }), verifiedProductLabel(product));
});

test('Three alias ingredients alone cannot establish the identity of the six-ingredient product', () => {
  assert.equal(verifiedProductLabel({ ...product, ingredients: ['ACETAMINOPHEN FINE', 'CAFFEINE ANHYDROUS', 'ASCORBIC ACID (COATED)'] }), undefined);
  for (const ingredients of [product.ingredients.slice(1), [...product.ingredients, 'UNRELATED'], product.ingredients.map(name => name === 'NOSCAPINE' ? 'OTHER' : name)])
    assert.equal(verifiedProductLabel({ ...product, ingredients }), undefined);
  assert.equal(verifiedProductLabel({ ...product, id: '衛署藥製字第045356號' }), undefined);
  assert.equal(verifiedProductLabel({ ...product, source: 'rxnorm' }), undefined);
});
