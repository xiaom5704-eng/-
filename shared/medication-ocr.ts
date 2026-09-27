import type { MedicationObservation } from './medication';

export type OcrTarget = 'label' | 'pill';
export type ScanEngine = 'vision' | 'package' | 'local' | 'gemini';
export interface OcrBox { left: number; top: number; width: number; height: number }
export interface OcrRegion { line: number; box: OcrBox }
export interface OcrReading {
  text: string; confidence: number;
  // Browser-only preview and original text. Edits invalidate spatial correspondence.
  layout?: { image: string; text: string; regions: OcrRegion[] };
}
export interface OcrPage extends OcrReading {
  fileName: string; page: number;
  reading?: 'native' | 'enlarged';
  alternative?: OcrReading;
  readNotice?: string;
}

export function switchOcrReading(page: OcrPage): OcrPage {
  if (!page.alternative) return page;
  const { text, confidence, layout } = page;
  return { ...page, ...page.alternative, layout: page.alternative.layout,
    alternative: { text, confidence, layout }, reading: page.reading === 'enlarged' ? 'native' : 'enlarged' };
}

export function withEnlargedReading(page: OcrPage, alternative: OcrReading): OcrPage {
  if (!alternative.text.trim()) return page;
  const result: OcrPage = { ...page, reading: 'native', alternative };
  return page.text.trim() ? result : switchOcrReading(result);
}

export function ocrRegions(items: { text: string; poly: [number, number][] }[], width: number, height: number): OcrRegion[] {
  if (!Number.isFinite(width + height) || width <= 0 || height <= 0) return [];
  const regions: OcrRegion[] = [];
  let line = 0;
  for (const item of items) {
    const text = item.text.trim();
    if (!text) continue;
    const lineCount = text.split(/\r?\n/).length;
    if (item.poly.length >= 3 && item.poly.every(point => point.length === 2 && point.every(Number.isFinite))) {
      const xs = item.poly.map(point => Math.max(0, Math.min(width, point[0])) / width * 100);
      const ys = item.poly.map(point => Math.max(0, Math.min(height, point[1])) / height * 100);
      const left = Math.min(...xs), top = Math.min(...ys);
      const box = { left, top, width: Math.max(...xs) - left, height: Math.max(...ys) - top };
      if (box.width > 0 && box.height > 0) {
        for (let offset = 0; offset < lineCount; offset++) regions.push({ line: line + offset, box });
      }
    }
    line += lineCount;
  }
  return regions;
}

// Enlarging a close-up can turn a short imprint into oversized detector input.
// Keep pill pixels at their original size; label photos retain the existing upscale.
export function ocrImageSize(width: number, height: number, target: OcrTarget) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) throw new Error('圖片尺寸無效，請重新拍攝。');
  const side = Math.max(width, height);
  const ratio = target === 'pill' ? Math.min(1, 1280 / side) : Math.min(Math.max(1, 1280 / side), 2400 / side);
  return { width: Math.max(1, Math.round(width * ratio)), height: Math.max(1, Math.round(height * ratio)) };
}

// Join OCR spacing between Chinese characters, but never guess letters, digits or strengths.
export function ocrLines(text: string, target: OcrTarget = 'label'): string[] {
  const lines = text.normalize('NFKC').split(/\r?\n/).map(line => line.trim()
    .replace(/(?<=[\u3400-\u9fff])\s+(?=[\u3400-\u9fff])/g, '').replace(/[\t ]+/g, ' ')).filter(Boolean);
  return target === 'pill' ? lines : [...new Set(lines)];
}

export function ocrReviewLines(page: OcrPage, target: OcrTarget): { text: string; boxes: OcrBox[] }[] {
  const regions = page.layout?.text === page.text ? page.layout.regions : [];
  const lines: { text: string; boxes: OcrBox[] }[] = [];
  for (const [index, raw] of page.text.split(/\r?\n/).entries()) {
    const text = ocrLines(raw, target)[0];
    if (!text) continue;
    const boxes = regions.filter(region => region.line === index).map(region => region.box);
    const previous = target === 'label' && lines.find(line => line.text === text);
    if (previous) previous.boxes.push(...boxes);
    else lines.push({ text, boxes });
  }
  return lines;
}

export function observationFromOcr(line: string, target: OcrTarget): MedicationObservation {
  const text = line.trim();
  if (!text || text.length > 120 || /[\r\n]/.test(text) || (target === 'label' && text.length < 2)) {
    throw new Error('請校正為一行完整藥名（2–120 字）或一面完整刻字（1–120 字）。');
  }
  return { name: target === 'label' ? text : '', strength: '', dosageForm: '',
    ...(target === 'pill' ? { appearance: { shape: '', color: '', imprints: [text] } } : {}) };
}

// Explicitly selected fragments from ONE label or ONE pill face. Never infer a
// grouping across pages, merge different medicines or rewrite ambiguous glyphs.
export function combineOcrLines(lines: string[], target: OcrTarget = 'label', maxLength = 120): string {
  if (!Number.isInteger(maxLength) || maxLength < 1 || maxLength > 120) throw new Error('文字長度限制無效。');
  if (lines.length < 2 || lines.length > 6 || lines.some(line => !line.trim() || /[\r\n]/.test(line)))
    throw new Error(target === 'pill' ? '請選取同一面刻字的 2–6 行；不要合併不同藥錠、正反面或背景文字。' : '請選取同一藥品的 2–6 行品牌、品名或規格。');
  const trimmed = lines.map(line => line.trim());
  const text = (target === 'pill' ? trimmed : [...new Set(trimmed)]).join(' ');
  if (text.length > maxLength) throw new Error(`合併文字超過 ${maxLength} 字，請減少選取或校正文字。`);
  return text;
}
