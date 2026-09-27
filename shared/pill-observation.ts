import type { MedicationObservation } from './medication';

export const pillShapes = ['圓形', '橢圓形', '膠囊', '四邊形', '三角形', '五邊形', '六邊形', '八邊形', '水滴形', '雙圓形', '其他', '不確定'] as const;
export const pillColors = ['白', '粉', '黃', '橘', '紅', '綠', '藍', '紫', '棕', '黑', '灰', '多色', '不確定'] as const;
export const pillObservationSchema = { type: 'object', properties: {
  kind: { type: 'string', enum: ['pill', 'package', 'other', 'unclear'] },
  shape: { type: 'string', enum: pillShapes }, color: { type: 'string', enum: pillColors },
  imprints: { type: 'array', items: { type: 'string' }, maxItems: 2 },
}, required: ['kind', 'shape', 'color', 'imprints'], additionalProperties: false };

export interface PillObservation {
  observation: MedicationObservation;
  model: string; checkedAt: string;
}

export function parsePillObservation(value: unknown): MedicationObservation {
  const item = value as Record<string, unknown> | null;
  if (!item || !['pill', 'package', 'other', 'unclear'].includes(item.kind as string) ||
      !pillShapes.includes(item.shape as typeof pillShapes[number]) || !pillColors.includes(item.color as typeof pillColors[number]) ||
      !Array.isArray(item.imprints) || item.imprints.length > 2 || item.imprints.some(mark => typeof mark !== 'string' || mark.length > 80) ||
      Object.keys(item).some(key => !['kind', 'shape', 'color', 'imprints'].includes(key))) throw new Error('本機模型未回傳有效外觀資料，請重試或手動輸入。');
  if (item.kind !== 'pill') throw new Error('未能確認照片是可核對的藥錠。藥盒／藥袋請使用 OCR，藥錠請補拍清楚近照。');
  // A score line is not a letter/digit imprint. Never substitute 0/O, 1/I or
  // invent a drug name from a model's visual description.
  const imprints = [...new Set((item.imprints as string[]).map(mark => mark.normalize('NFKC').trim()).filter(mark => /[A-Za-z0-9\u3400-\u9fff]/.test(mark)))];
  const shape = item.shape === '不確定' || item.shape === '其他' ? '' : item.shape as string;
  const color = item.color === '不確定' || item.color === '多色' ? '' : item.color as string;
  if (!imprints.length && !(shape && color)) throw new Error('照片中的特徵仍不足，請補拍刻字近照或手動輸入。');
  return { name: '', strength: '', dosageForm: '', appearance: { shape, color, imprints } };
}
