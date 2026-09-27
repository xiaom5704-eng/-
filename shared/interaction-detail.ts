export interface InteractionDetail {
  id: string;
  drugIds: [string, string];
  drugNames: [string, string];
  level: string;
  interaction: string;
  management: string;
  references: string[];
  sourceUrl: string;
  retrievedAt: string;
  sha256: string;
  contentSha256: string;
  summary?: { text: string; reviewedAt: string };
}

export const interactionDetailScope = '這是成分層級的來源說明，包含藥物類別的共通警語；未依本次年齡、劑量或病況個別判定，也不能用來證明案例症狀的原因。';
