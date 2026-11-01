/**
 * SMTP wrapper around `nodemailer`. Same short-lived-connection
 * philosophy as `imap.ts` - we open a transport per send. For the
 * volume one operator does it's fine; if we ever batch outbound,
 * promote this to a pooled transporter.
 */

import nodemailer from 'nodemailer';
import type Mail from 'nodemailer/lib/mailer';
import type SMTPTransport from 'nodemailer/lib/smtp-transport';
import net from 'node:net';

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

export async function sendMail(auth: SmtpAuth, input: SendInput): Promise<{ messageId: string }> {
  const options: SMTPTransport.Options = {
    host: auth.host,
    port: auth.port,
    secure: auth.port === 465,
    // Non-465 submission is STARTTLS, and nodemailer's default is to UPGRADE
    // opportunistically — so a host that doesn't advertise STARTTLS (or a
    // downgrade in front of it) gets the mailbox password in cleartext. Every
    // real submission host supports it; refusing to send is the right failure.
    requireTLS: auth.port !== 465,
    auth: { user: auth.user, pass: auth.pass },
    // Use the OS resolver, as IMAP does, so Docker's extra_hosts and other
    // administrator-managed host mappings apply to submission too. Nodemailer's
    // DNS-first resolver can bypass /etc/hosts when DNS returns a wrong address.
    // Hand over plain TCP; Nodemailer still verifies implicit TLS or STARTTLS
    // against auth.host before authenticating.
    getSocket(_options, callback) {
      const socket = net.createConnection({ host: auth.host, port: auth.port });
      let settled = false;
      const timer = setTimeout(() => {
        fail(Object.assign(new Error('SMTP connection timed out'), { code: 'ETIMEDOUT' }));
      }, 10_000);
      function fail(error: Error) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.removeListener('connect', connected);
        socket.destroy();
        callback(error, undefined);
      }
      function connected() {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.removeListener('error', fail);
        callback(null, { connection: socket });
      }
      socket.once('error', fail);
      socket.once('connect', connected);
    },
  };
  const transporter = nodemailer.createTransport(options);

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
