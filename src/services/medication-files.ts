export const MAX_FILE_BYTES = 8 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 12 * 1024 * 1024;
export const ALLOWED_FILE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];

export function filePart(dataUrl: string) {
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/=\r\n]+)$/.exec(dataUrl);
  if (!match || !ALLOWED_FILE_TYPES.includes(match[1])) throw new Error('僅支援 JPEG、PNG、WebP 或 PDF。');
  return { inlineData: { mimeType: match[1], data: match[2] } };
}
