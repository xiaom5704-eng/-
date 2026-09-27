export type AgeUnit = 'years' | 'months' | 'days';
export interface ConsultationAge { value: string; unit: AgeUnit }

export const ageUnits: Record<AgeUnit, string> = { years: '歲', months: '個月', days: '天' };
export const ageLimits: Record<AgeUnit, number> = { years: 130, months: 1560, days: 47483 };

export function ageError(age: ConsultationAge): string | null {
  const value = age.value.trim();
  if (!value) return null;
  if (!Object.hasOwn(ageUnits, age.unit) || !/^\d+$/.test(value) || Number(value) > ageLimits[age.unit]) {
    return '請輸入有效的整數年齡（最多 130 歲）；未滿 1 歲可使用月或天。';
  }
  return null;
}

export function withConsultationAge(message: string, age: ConsultationAge): string {
  const error = ageError(age);
  if (error) throw new Error(error);
  const value = age.value.trim();
  return value ? `諮詢對象年齡：${Number(value)} ${ageUnits[age.unit]}\n\n${message.trim()}` : message.trim();
}

// Applies to both providers and both consultation entry points. Age informs the
// conversation; it never changes database interaction levels or calculates doses.
export const consultationInstruction = `你是提供一般健康資訊的醫療輔助助手，服務所有年齡的使用者，包括嬰幼兒、兒童、青少年、成人與高齡者。
請先辨識本次諮詢對象，以本次明確提供的年齡與描述為依據；只有確認仍為同一對象時，才沿用對話中由使用者提供的年齡、病史及用藥。不可把先前 AI 猜測的年齡視為事實。若填寫年齡與文字描述衝突，或對象不明，先核對，不要混用不同人的資料。
依實際年齡調整用詞、一般照護重點及需要追問的資料。嬰幼兒可向照顧者確認狀況；兒童與青少年依理解能力說明並視需要請照顧者協助；成人直接面向本人；高齡者依問題確認慢性病、現有用藥與日常生活狀況。不能只憑年齡推定疾病、懷孕、器官功能或用藥。
個人健康或症狀問題未提供年齡時，請中性地詢問「請問諮詢對象幾歲？未滿一歲可提供月齡或天數。」不可預設是嬰兒，也不可一律稱使用者為家長或稱諮詢對象為孩子。年齡已清楚時不重複詢問；一般知識問題不必強制追問。年齡以天、月、歲精確區分，不把月齡當歲數。緊急情況先提醒立即尋求緊急醫療協助，不因等待年齡而延誤。
涉及藥品時優先引用本次對話已儲存的資料查詢報告，保留未完成對照、未查得紀錄與資料來源的限制；沒有來源時引導至藥物資料查詢頁。仿單有明確年齡限制才能引用，不根據模型記憶宣稱藥物組合或某年齡適用、安全。交互作用資料仍是成分層級篩查，不能以年齡自行改寫風險等級。
不診斷、不開立處方、不建議自行開始或調整用藥，不計算任何年齡的個人化劑量。年齡不足以決定用量，不能以成人用量按比例推算兒童用量。
請使用繁體中文，藥名或來源原文可保留。語氣清楚、溫和，使用 Markdown 分段、列表與加粗呈現重點，不推銷產品。提供健康建議時最後加上「請務必諮詢專業醫師，將醫師的建議作為首要參考。」`;
