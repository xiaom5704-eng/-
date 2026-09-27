// Candidate retrieval from product names only. These are written unit aliases,
// not dose equivalence, ingredient identity, or an inferred prescribing dose.
const units: Record<string, string> = {
  mg: 'mg', 毫克: 'mg', 公絲: 'mg', 公丝: 'mg',
  g: 'g', 公克: 'g', 克: 'g',
  mcg: 'mcg', ug: 'mcg', μg: 'mcg', 微克: 'mcg',
  ml: 'ml', 毫升: 'ml', 公撮: 'ml',
  l: 'l', 公升: 'l', 升: 'l', '%': '%',
};
const scalar = String.raw`(?:\d+(?:[.,]\d+)*|\.\d+)`;
// Preserve non-scalar spellings literally: a range is not a concatenated number,
// and fractions, grouped numbers and scientific notation are not converted.
const number = `[-+−±]?${scalar}(?:(?:\\s*[-+−±~～–—×^/]\\s*|e[-+]?)${scalar})*`;
const unit = `(?:${Object.keys(units).sort((a, b) => b.length - a.length).join('|')})`;
const pattern = new RegExp(`(${number})\\s*(${unit})(?![a-zμ])((?:\\s*/\\s*(?:${number}\\s*)?(?:${unit}|[a-zμ]+)(?![a-zμ]))*)`, 'gi');
const denominatorPattern = new RegExp(`^(${number})?\\s*(${unit})$`, 'i');

// Canonical decimal spelling without float conversion or changing magnitudes.
function decimal(value: string) {
  if (!/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(value)) return value.replace(/\s/g, '');
  const [integer = '', fraction = ''] = value.split('.');
  const left = integer.replace(/^0+/, '') || '0', right = fraction.replace(/0+$/, '');
  return right ? `${left}.${right}` : left;
}

export function splitSearchMeasurements(value: string) {
  const normalized = value.normalize('NFKC').toLowerCase();
  const measurements: string[] = [];
  const text = normalized.replace(pattern, (raw: string, amount: string, numerator: string, ratio: string, offset: number) => {
    const before = normalized.slice(0, offset), after = normalized.slice(offset + raw.length);
    // Reject incomplete matches; do not silently extract just a numeric tail.
    if (/[\d.,/]/.test(before.slice(-1)) || /(?:[-−±+~～–—×^/]\s*|\d[eE][-+]?\s*)$/.test(before) || /^\s*[/／]/.test(after)) return raw;
    const per = ratio.split('/').slice(1).map(part => {
      const match = denominatorPattern.exec(part.trim());
      return match ? `${decimal(match[1] || '1')}${units[match[2]]}` : part.replace(/\s/g, '');
    });
    const key = [decimal(amount) + units[numerator], ...per].join('/');
    measurements.push(key);
    return ' ';
  });
  return { text, measurements: [...new Set(measurements)] };
}

export function measurementSearchNotice(query: string): string[] {
  const { measurements } = splitSearchMeasurements(query);
  return measurements.length ? [`已核對品名中的規格：${measurements.join('、')}。未換算單位或推算劑量；品名未記載規格時，可改用藥名搜尋，再核對仿單。`] : [];
}
