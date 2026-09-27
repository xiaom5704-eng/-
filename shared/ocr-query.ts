export interface OcrQuerySuggestion { query: string; prefix: string; suffix: string }

// Only propose a query from explicit label boundaries. Keep the original OCR
// text, strengths and directions available for review; never interpret a dose.
const nameLabel = /(?:藥品名稱|中文品名|英文品名|商品名稱|商品名|藥名|品名)\s*:/g;
const leadingNameLabel = /^(?:藥品名稱|中文品名|英文品名|商品名稱|商品名|藥名|品名)\s*:\s*/;
const labeledTail = /(?:包裝數量|用法用量|服用方法|給藥途徑|注意事項|用法|用量|頻次|每次|每日|天數|總量|數量|劑量)\s*:|\b(?:sig|qty|quantity|directions|dose)\s*:/i;
// Unlabelled free text is left intact, except literal Chinese frequency fields
// with a written number + unit. This does not calculate or validate that value.
const frequencyTail = /(?:每次\s*\d+(?:\.\d+)?\s*(?:錠|粒|顆|包|滴|毫升|ml\b)|(?:每日|每天|一天)\s*\d+\s*次)/i;

export function suggestOcrQuery(line: string): OcrQuerySuggestion | undefined {
  if (!line.trim() || line.length > 1000 || /[\r\n]/.test(line)) return;
  const text = line.normalize('NFKC').trim();
  // A row containing multiple labelled products must be separated by the user.
  if ([...text.matchAll(nameLabel)].length > 1) return;
  const prefix = leadingNameLabel.exec(text)?.[0] || '';
  const body = text.slice(prefix.length);
  const boundaries = [labeledTail.exec(body)?.index, frequencyTail.exec(body)?.index].filter((value): value is number => value !== undefined);
  const end = boundaries.length ? Math.min(...boundaries) : body.length;
  const beforeTail = body.slice(0, end);
  const query = beforeTail.replace(/[\s|;]+$/, '').trim();
  const suffix = body.slice(query.length).trim();
  if ((!prefix && !suffix) || query.length < 2 || query.length > 120 || /[:：]/.test(query)) return;
  return { query, prefix: prefix.trim(), suffix };
}
