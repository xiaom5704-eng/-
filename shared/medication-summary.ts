import type { MedicationReport } from './medication';
import { escapeMarkdown, sourceMarkdownLink } from './medication';
import { patientAgeText, safetyKindText } from './medication-safety';

const words = {
  '繁體中文': {
    saved: '仿單紀錄取得時間', reused: '重用本機紀錄', refresh_failed: '更新失敗、沿用先前仿單紀錄的品項數', stale: '已超過更新提醒門檻的仿單品項數', incomplete: '僅完成部分篩選、尚未找到相符仿單的品項數',
    not_requested: '本機模式未查詢線上仿單的品項數',
    title: '查詢摘要', selected: '已確認品項', pair: '成分配對', empty: '沒有可比較的成分配對，無法據此判定用藥安全。',
    found: 'DDInter 查得紀錄', not_found: '已匯入 DDInter 資料中未查得紀錄（不代表安全）',
    unmapped: '成分未完成 DDInter 對照，無法判定', not_imported: 'DDInter 尚未載入，無法判定', duplicate: '成分重複，請由藥師核對',
    level: '資料庫風險等級', labels: '相關美國仿單份數', unavailable: '仿單服務無法連線的品項數', missing: '未查得相符仿單的品項數', unresolved: '因成分未對照而未查詢仿單的品項數',
    scope: '仿單僅按成分篩選，尚未核對產品規格、劑型與適應症；用量不能直接套用到臺灣產品或兒童。',
    limits: '查無紀錄或未完成對照不代表沒有風險。此摘要保留查詢狀態，不推算劑量；個人用藥請由醫師或藥師核對。',
    Major: '重大', Moderate: '中度', Minor: '輕度', Unknown: '未知',
  },
  English: {
    saved: 'Label data retrieved at', reused: 'Reused local record', refresh_failed: 'Entries whose label refresh failed; prior records retained', stale: 'Entries past the label update reminder threshold', incomplete: 'Entries only partially screened, with no matching label found yet',
    not_requested: 'Entries without an online label search (local mode)',
    title: 'Query summary', selected: 'Confirmed entries', pair: 'Ingredient pair', empty: 'There are no ingredient pairs to compare. This does not establish medication safety.',
    found: 'Record found in DDInter', not_found: 'No record found in the imported DDInter data (does not mean safe)',
    unmapped: 'Ingredient not mapped to DDInter; unable to assess', not_imported: 'DDInter data not loaded; unable to assess', duplicate: 'Duplicate ingredient; ask a pharmacist to review',
    level: 'Database risk level', labels: 'Related US label records', unavailable: 'Entries with unavailable label service', missing: 'Entries without a matching label in this query', unresolved: 'Entries without a label search because ingredient mapping is incomplete',
    scope: 'Labels were filtered by ingredients only. Strength, formulation and indications have not been matched; dosing cannot be directly applied to Taiwanese products or children.',
    limits: 'Missing records or incomplete mapping do not establish absence of risk. This summary preserves query statuses and does not calculate doses. Ask a clinician or pharmacist to review individual medication use.',
    Major: 'Major', Moderate: 'Moderate', Minor: 'Minor', Unknown: 'Unknown',
  },
  '日本語': {
    saved: '添付文書データ取得日時', reused: '保存済みの記録を使用', refresh_failed: '更新に失敗し以前の添付文書記録を使用した項目数', stale: '更新確認の目安を過ぎた項目数', incomplete: '一部のみ照合済みで一致する添付文書が未確認の項目数',
    not_requested: 'ローカルモードでオンライン添付文書を検索していない項目数',
    title: '検索結果の要約', selected: '確認済みの項目', pair: '成分の組み合わせ', empty: '比較できる成分の組み合わせがありません。安全性を確認したという意味ではありません。',
    found: 'DDInter に記録あり', not_found: '取り込んだ DDInter データに記録なし（安全という意味ではありません）',
    unmapped: 'DDInter への成分照合が未完了のため判定できません', not_imported: 'DDInter データ未取得のため判定できません', duplicate: '成分の重複あり。薬剤師に確認してください',
    level: 'データベースのリスク区分', labels: '関連する米国添付文書の件数', unavailable: '添付文書サービスに接続できない項目数', missing: '今回の検索で一致する添付文書がない項目数', unresolved: '成分照合が未完了で添付文書を検索できない項目数',
    scope: '添付文書は成分のみで検索しています。規格、剤形、適応症は照合していないため、用量を台湾製品や小児にそのまま適用できません。',
    limits: '記録がないことや照合未完了は、リスクがないことを意味しません。この要約は検索状態を示すもので、用量計算は行いません。個別の服薬は医師・薬剤師に確認してください。',
    Major: '重大', Moderate: '中程度', Minor: '軽度', Unknown: '不明',
  },
  'Tiếng Việt': {
    saved: 'Thời điểm lấy dữ liệu nhãn', reused: 'Dùng lại bản ghi cục bộ', refresh_failed: 'Số mục cập nhật nhãn thất bại, giữ bản ghi trước', stale: 'Số mục quá ngưỡng nhắc cập nhật nhãn', incomplete: 'Số mục mới sàng lọc một phần, chưa tìm thấy nhãn phù hợp',
    not_requested: 'Số mục chưa tra nhãn trực tuyến (chế độ cục bộ)',
    title: 'Tóm tắt kết quả tra cứu', selected: 'Mục đã xác nhận', pair: 'Cặp hoạt chất', empty: 'Không có cặp hoạt chất để so sánh. Điều này không xác nhận thuốc an toàn.',
    found: 'Có bản ghi trong DDInter', not_found: 'Không tìm thấy bản ghi trong dữ liệu DDInter đã nhập (không có nghĩa là an toàn)',
    unmapped: 'Chưa đối chiếu hoạt chất với DDInter; không thể đánh giá', not_imported: 'Chưa tải dữ liệu DDInter; không thể đánh giá', duplicate: 'Trùng hoạt chất; cần dược sĩ kiểm tra',
    level: 'Mức nguy cơ trong cơ sở dữ liệu', labels: 'Số nhãn thuốc Hoa Kỳ liên quan', unavailable: 'Số mục không kết nối được dịch vụ nhãn thuốc', missing: 'Số mục chưa tìm thấy nhãn phù hợp trong lần tra cứu này', unresolved: 'Số mục chưa tra nhãn do chưa đối chiếu được hoạt chất',
    scope: 'Nhãn chỉ được lọc theo hoạt chất. Chưa đối chiếu hàm lượng, dạng bào chế và chỉ định; không áp dụng trực tiếp liều dùng cho sản phẩm Đài Loan hoặc trẻ em.',
    limits: 'Thiếu bản ghi hoặc chưa đối chiếu không có nghĩa là không có nguy cơ. Bản tóm tắt giữ nguyên trạng thái tra cứu và không tính liều. Hãy nhờ bác sĩ hoặc dược sĩ kiểm tra việc dùng thuốc cho từng người.',
    Major: 'Nghiêm trọng', Moderate: 'Trung bình', Minor: 'Nhẹ', Unknown: 'Chưa rõ',
  },
};

// Clinical states are rendered from the database response, never inferred by a model.
export function summarizeMedicationReport(report: MedicationReport, language = '繁體中文'): string {
  const w = words[language as keyof typeof words] || words['繁體中文'];
  const lines = [`### ${w.title}`, `${w.selected}：${report.medications.map(m => escapeMarkdown(m.drug.name)).join('、')}`];
  if (report.demo) lines.push(`教學示範／Teaching example：${escapeMarkdown(report.demo.description)}`);
  if (report.safety) {
    lines.push(`年齡與併用核對（以下保留繁體中文來源摘要）／Age-related review：${patientAgeText(report.safety.patient)}`);
    for (const alert of report.safety.alerts) lines.push(`- ${safetyKindText[alert.kind]}：${escapeMarkdown(alert.title)}。${escapeMarkdown(alert.detail)} ${alert.sources.map(source => sourceMarkdownLink(source.title, source.url)).join('、')}`);
    lines.push('僅依有限品項規則核對，未觸發不代表安全。完整限制與資料缺口請見原始報告。');
  }
  if (!report.interactions.length) lines.push(w.empty);
  for (const pair of report.interactions.filter(p => p.status === 'duplicate' || p.status === 'found').sort((a, b) => Number(b.status === 'duplicate') - Number(a.status === 'duplicate'))) {
    lines.push(`- ${w.pair}（${escapeMarkdown(pair.drugA)}／${escapeMarkdown(pair.drugB)}）：${escapeMarkdown(pair.ingredientA)} + ${escapeMarkdown(pair.ingredientB)} — ${w[pair.status]}${pair.level ? `；${w.level}：${w[pair.level as 'Major' | 'Moderate' | 'Minor' | 'Unknown'] || escapeMarkdown(pair.level)}` : ''}`);
  }
  for (const status of ['not_found', 'unmapped', 'not_imported'] as const) {
    const count = report.interactions.filter(p => p.status === status).length;
    if (count) lines.push(`- ${w.pair}：${count} — ${w[status]}`);
  }
  lines.push(`${w.labels}：${report.medications.reduce((n, m) => n + m.labels.length, 0)}`);
  for (const [status, label] of [['unavailable', w.unavailable], ['not_found', w.missing], ['unmapped', w.unresolved], ['not_requested', w.not_requested], ['incomplete', w.incomplete]]) {
    const count = report.medications.filter(m => m.labelStatus === status).length;
    if (count) lines.push(`${label}：${count}`);
  }
  for (const entry of report.medications) if (entry.labelLookup) {
    lines.push(`${escapeMarkdown(entry.drug.name)} — ${w.saved}：${entry.labelLookup.retrievedAt}${entry.labelLookup.reused ? `（${w.reused}）` : ''}`);
  }
  const failed = report.medications.filter(entry => entry.labelLookup?.refresh === 'failed').length;
  const stale = report.medications.filter(entry => entry.labelLookup?.stale).length;
  if (failed) lines.push(`${w.refresh_failed}：${failed}`);
  if (stale) lines.push(`${w.stale}：${stale}`);
  lines.push(w.scope, w.limits);
  return lines.join('\n\n');
}
