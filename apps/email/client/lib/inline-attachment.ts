// A blob URL runs in the webmail's origin, and the attachment's type is chosen by
// the sender, so only types the browser renders without running script open inline.
const INLINE_ATTACHMENT_TYPES = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/bmp',
  'text/plain',
  'audio/mpeg',
  'audio/ogg',
  'audio/wav',
  'video/mp4',
  'video/webm',
]);

/** The type to open the attachment inline with, or null when it must be downloaded. */
export const getInlineAttachmentType = (mimeType: string) => {
  const type = mimeType.toLowerCase().split(';')[0]?.trim() ?? '';
  return INLINE_ATTACHMENT_TYPES.has(type) ? type : null;
};
