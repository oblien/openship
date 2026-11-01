import { describe, expect, it } from 'bun:test';
import { getInlineAttachmentType } from './inline-attachment';

describe('getInlineAttachmentType', () => {
  it('opens passive formats inline with a normalized type', () => {
    expect(getInlineAttachmentType('application/pdf')).toBe('application/pdf');
    expect(getInlineAttachmentType('IMAGE/PNG; name="a.png"')).toBe('image/png');
  });

  it('downloads anything that can run script in our origin', () => {
    for (const type of [
      'text/html',
      'TEXT/HTML; charset=utf-8',
      'image/svg+xml',
      'application/xhtml+xml',
      'text/xml',
      'text/plain, text/html',
      '',
    ]) {
      expect(getInlineAttachmentType(type)).toBeNull();
    }
  });
});
