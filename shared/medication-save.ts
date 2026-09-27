export const medicationReportQuestion = '請查詢我已確認藥品的交互作用與仿單資料。';
export interface MedicationSaveAttempt { requestId: string; content: string }

// A retry keeps the exact snapshot and identity. An edited report is a new save.
export function medicationSaveAttempt(content: string, previous: MedicationSaveAttempt | null, newId: () => string = () => crypto.randomUUID()): MedicationSaveAttempt {
  return previous?.content === content ? previous : { content, requestId: newId() };
}
