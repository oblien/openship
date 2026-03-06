import nodemailer from "nodemailer";
import { env } from "../config/env";

/**
 * Lightweight email sender using SMTP.
 *
 * Only available when SMTP_HOST is configured.
 * Self-hosted instances without SMTP skip email-dependent features
 * (verification, password reset) gracefully.
 */

export const smtpEnabled = !!(env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASS);

export type SendMailOptions = {
  to: string;
  subject: string;
  html: string;
  text?: string;
};

/** Reusable transport — created once when SMTP is available. */
const transport = smtpEnabled
  ? nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT ?? 587,
      secure: (env.SMTP_PORT ?? 587) === 465,
      auth: {
        user: env.SMTP_USER,
        pass: env.SMTP_PASS,
      },
    })
  : null;

/** Send an email via SMTP. No-ops when SMTP is not configured. */
export async function sendMail(opts: SendMailOptions): Promise<void> {
  if (!transport) {
    console.warn("[mail] SMTP not configured — skipping email to", opts.to);
    return;
  }

  await transport.sendMail({
    from: env.SMTP_FROM,
    to: opts.to,
    subject: opts.subject,
    html: opts.html,
    ...(opts.text ? { text: opts.text } : {}),
  });
}
