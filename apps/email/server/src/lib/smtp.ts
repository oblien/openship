/**
 * SMTP wrapper around `nodemailer`. Same short-lived-connection
 * philosophy as `imap.ts` - we open a transport per send. For the
 * volume one operator does it's fine; if we ever batch outbound,
 * promote this to a pooled transporter.
 */

import nodemailer from 'nodemailer';
import type Mail from 'nodemailer/lib/mailer';

export interface SmtpAuth {
  host: string;
  port: number;
  user: string;
  pass: string;
}

export interface SendInput {
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  text?: string;
  html?: string;
  inReplyTo?: string;
  references?: string[];
  headers?: Record<string, string>;
  attachments?: Mail.Attachment[];
}

export async function sendMail(
  auth: SmtpAuth,
  input: SendInput,
): Promise<{ messageId: string }> {
  const transporter = nodemailer.createTransport({
    host: auth.host,
    port: auth.port,
    secure: auth.port === 465,
    auth: { user: auth.user, pass: auth.pass },
  });

  try {
    const info = await transporter.sendMail({
      from: input.from,
      to: input.to,
      cc: input.cc,
      bcc: input.bcc,
      subject: input.subject,
      text: input.text,
      html: input.html,
      inReplyTo: input.inReplyTo,
      references: input.references,
      headers: input.headers,
      attachments: input.attachments,
    });
    return { messageId: info.messageId };
  } finally {
    transporter.close();
  }
}
