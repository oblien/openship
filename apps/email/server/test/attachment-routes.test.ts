import { afterAll, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import type { AppContext } from '../src/ctx';
import { mailRouteInternals, mailRouter } from '../src/trpc/routes/mail';

const ctx = {
  session: {
    sessionId: 'session-1',
    email: 'sender@example.com',
    name: 'Sender',
    password: 'password',
    imapHost: 'imap.example.com',
    imapPort: 993,
    smtpHost: 'smtp.example.com',
    smtpPort: 465,
    expiresAt: new Date('2099-01-01T00:00:00.000Z'),
  },
  imap: { host: 'imap.example.com', port: 993, user: 'sender@example.com', pass: 'password' },
  smtp: { host: 'smtp.example.com', port: 465, user: 'sender@example.com', pass: 'password' },
  hono: null,
} satisfies AppContext;

const attachment = {
  id: 'message-1-0',
  attachmentId: 'message-1-0',
  filename: 'report.txt',
  contentType: 'text/plain',
  mimeType: 'text/plain',
  size: 6,
  inline: false,
  body: Buffer.from('report').toString('base64'),
  headers: [],
};

const getThread = spyOn(mailRouteInternals, 'getThread');
const send = spyOn(mailRouteInternals, 'send');
const caller = mailRouter.createCaller(ctx);

beforeEach(() => {
  getThread.mockReset();
  send.mockReset();
});

afterAll(() => {
  getThread.mockRestore();
  send.mockRestore();
});

describe('attachment byte routes', () => {
  it('loads download bytes from the requested mailbox', async () => {
    getThread.mockResolvedValueOnce({ latest: { attachments: [attachment] } } as never);

    await expect(
      caller.getMessageAttachments({ messageId: 'message-1', folder: 'sent' }),
    ).resolves.toEqual([attachment]);
    expect(getThread).toHaveBeenCalledWith(ctx.imap, 'message-1', 'sent', undefined, {
      includeAttachmentBytes: true,
    });
  });

  it('loads the original from its mailbox and keeps user-added forward attachments', async () => {
    getThread.mockResolvedValueOnce({
      latest: { decodedBody: '<p>Original</p>', attachments: [attachment] },
    } as never);
    send.mockResolvedValueOnce({ messageId: 'forwarded-message' });

    await caller.send({
      to: [{ email: 'recipient@example.com' }],
      subject: 'Fwd: report',
      message: '<p>Intro</p>',
      attachments: [{ name: 'added.txt', type: 'text/plain', base64: 'YWRkZWQ=' }],
      isForward: true,
      originalMessageId: 'message-1',
      originalFolder: 'archive',
    });

    expect(getThread).toHaveBeenCalledWith(ctx.imap, 'message-1', 'archive', undefined, {
      includeAttachmentBytes: true,
    });
    expect(send).toHaveBeenCalledWith(
      ctx.smtp,
      ctx.imap,
      '"Sender" <sender@example.com>',
      expect.objectContaining({
        html: '<p>Intro</p><p>Original</p>',
        attachments: [
          { name: 'report.txt', type: 'text/plain', base64: attachment.body },
          { name: 'added.txt', type: 'text/plain', base64: 'YWRkZWQ=' },
        ],
      }),
    );
  });

  it('does not silently send a forward when its original cannot be loaded', async () => {
    getThread.mockResolvedValueOnce(null);

    await expect(
      caller.send({
        to: [{ email: 'recipient@example.com' }],
        subject: 'Fwd: missing',
        message: '<p>Intro</p>',
        isForward: true,
        originalMessageId: 'missing-message',
        originalFolder: 'trash',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(send).not.toHaveBeenCalled();
  });

  it('preserves a valid zero-byte attachment when forwarding', async () => {
    getThread.mockResolvedValueOnce({
      latest: {
        decodedBody: '<p>Original</p>',
        attachments: [{ ...attachment, filename: 'empty.txt', size: 0, body: '' }],
      },
    } as never);
    send.mockResolvedValueOnce({ messageId: 'forwarded-message' });

    await caller.send({
      to: ['recipient@example.com'],
      subject: 'Fwd: empty attachment',
      isForward: true,
      originalMessageId: 'message-1',
      originalFolder: 'sent',
    });

    expect(send).toHaveBeenCalledWith(
      ctx.smtp,
      ctx.imap,
      '"Sender" <sender@example.com>',
      expect.objectContaining({
        attachments: [{ name: 'empty.txt', type: 'text/plain', base64: '' }],
      }),
    );
  });
});
