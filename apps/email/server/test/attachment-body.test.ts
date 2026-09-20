import { describe, expect, it } from 'bun:test';
import { encodeAttachmentBody } from '../src/lib/imap-driver';

describe('encodeAttachmentBody', () => {
  const content = Buffer.from('non-empty attachment');

  it('keeps attachment bytes out of normal thread reads', () => {
    expect(encodeAttachmentBody(content)).toBe('');
  });

  it('returns base64 bytes for explicit download and forward reads', () => {
    expect(encodeAttachmentBody(content, true)).toBe(content.toString('base64'));
  });
});
