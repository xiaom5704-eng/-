export const MAX_FILE_BYTES = 8 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 12 * 1024 * 1024;
export const ALLOWED_FILE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];

type AttachmentContent = { name: string; data: string; type: string; size: number };
export type MedicationAttachment = AttachmentContent & { id: string; original?: AttachmentContent };

// Reserve enough room to restore any cropped photo without exceeding scan limits.
export function assertAttachmentLimits(files: readonly { size: number; original?: { size: number } }[]) {
  const sizes = files.map(file => Math.max(file.size, file.original?.size || 0));
  if (sizes.some(size => size > MAX_FILE_BYTES) || sizes.reduce((total, size) => total + size, 0) > MAX_TOTAL_BYTES) {
    throw new Error('單檔上限 8 MB，全部檔案合計上限 12 MB（裁切照片會保留原圖的還原空間）。');
  }
}

export function cropAttachment(file: MedicationAttachment, data: string): MedicationAttachment {
  const { inlineData } = filePart(data);
  if (file.type === 'application/pdf' || inlineData.mimeType !== 'image/jpeg') throw new Error('裁切結果必須是 JPEG 照片。');
  const original = file.original || { name: file.name, data: file.data, type: file.type, size: file.size };
  const encoded = inlineData.data.replace(/\s/g, '');
  return { id: crypto.randomUUID(), name: original.name.replace(/\.[^.]+$/, '') + '-裁切.jpg', data, type: 'image/jpeg',
    size: encoded.length * 3 / 4 - (encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0), original };
}

export function restoreAttachment(file: MedicationAttachment): MedicationAttachment {
  return file.original ? { ...file.original, id: crypto.randomUUID() } : file;
}

export function filePart(dataUrl: string) {
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/=\r\n]+)$/.exec(dataUrl);
  if (!match || !ALLOWED_FILE_TYPES.includes(match[1])) throw new Error('僅支援 JPEG、PNG、WebP 或 PDF。');
  return { inlineData: { mimeType: match[1], data: match[2] } };
}
