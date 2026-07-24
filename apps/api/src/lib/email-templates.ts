/**
 * Email templates for Openship.
 *
 * Each template returns { subject, html, text } so they can be
 * passed directly to sendMail(). Keep all copy and markup here
 * so auth.ts / other callers stay clean.
 */

/* ------------------------------------------------------------------ */
/*  Shared layout                                                      */
/* ------------------------------------------------------------------ */

const BRAND = "Openship";

/**
 * Escape a value for interpolation into HTML text/attribute content
 * (`&`, `<`, `>`, `"`, `'`). Applied to user-controlled fields in the `html`
 * output only; the `subject` and `text` parts are plaintext and keep the raw
 * value.
 */
function htmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function layout(body: string) {
  return `
<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8" /><meta name="viewport" content="width=device-width" /></head>
<body style="margin:0;padding:0;background:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:40px 20px">
    <tr><td align="center">
      <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:16px;padding:40px;border:1px solid #e5e7eb">
        <tr><td>
          ${body}
          <p style="color:#9ca3af;font-size:12px;margin-top:32px;border-top:1px solid #f3f4f6;padding-top:16px">
            &copy; ${BRAND}
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`.trim();
}

function ctaButton(url: string, label: string) {
  return `
<table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px 0">
  <tr><td align="center" style="background:#000;border-radius:10px">
    <a href="${url}" target="_blank" style="display:inline-block;padding:12px 28px;color:#fff;font-size:14px;font-weight:600;text-decoration:none">${label}</a>
  </td></tr>
</table>`.trim();
}

function greeting(name?: string | null) {
  return `<p style="color:#111;font-size:15px;margin:0 0 16px">Hi ${htmlEscape(name || "there")},</p>`;
}

/* ------------------------------------------------------------------ */
/*  Reset password                                                     */
/* ------------------------------------------------------------------ */

export function resetPasswordEmail(user: { name?: string | null; email: string }, url: string) {
  const html = layout(`
    ${greeting(user.name)}
    <p style="color:#374151;font-size:14px;line-height:1.6;margin:0 0 4px">
      We received a request to reset your password. Click the button below to choose a new one.
    </p>
    ${ctaButton(url, "Reset password")}
    <p style="color:#9ca3af;font-size:13px;margin:0">
      If you didn't request this, you can safely ignore this email. The link expires in 1 hour.
    </p>
  `);

  return {
    subject: "Reset your Openship password",
    html,
    text: `Hi ${user.name || "there"},\n\nReset your password: ${url}\n\nIf you didn't request this, ignore this email. The link expires in 1 hour.`,
  };
}

/* ------------------------------------------------------------------ */
/*  Verify email                                                       */
/* ------------------------------------------------------------------ */

export function verifyEmailTemplate(user: { name?: string | null; email: string }, url: string) {
  const html = layout(`
    ${greeting(user.name)}
    <p style="color:#374151;font-size:14px;line-height:1.6;margin:0 0 4px">
      Please verify your email address to get started with ${BRAND}.
    </p>
    ${ctaButton(url, "Verify email")}
    <p style="color:#9ca3af;font-size:13px;margin:0">
      If you didn't create an account, you can ignore this email.
    </p>
  `);

  return {
    subject: "Verify your Openship email",
    html,
    text: `Hi ${user.name || "there"},\n\nVerify your email: ${url}\n\nIf you didn't create an account, ignore this email.`,
  };
}

/* ------------------------------------------------------------------ */
/*  Verify email — OTP code (no link, for deliverability)              */
/* ------------------------------------------------------------------ */

/** Prominent, monospaced code block — the only "content" of an OTP email. */
function codeBlock(code: string) {
  return `
<table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px 0">
  <tr><td align="center" style="background:#f3f4f6;border:1px solid #e5e7eb;border-radius:10px;padding:18px 28px">
    <span style="font-family:'SF Mono',Menlo,Consolas,monospace;font-size:30px;font-weight:700;letter-spacing:8px;color:#111">${code}</span>
  </td></tr>
</table>`.trim();
}

/**
 * Email-verification via a short numeric CODE the user types, NOT a magic link.
 * Codes are far more deliverable — no clickable URL for spam filters to flag,
 * no link-tracking heuristics — which is the whole point of using OTP here.
 * Intentionally contains ZERO links.
 */
export function verifyOtpEmailTemplate(
  code: string,
  opts?: { name?: string | null; expiresMinutes?: number },
) {
  const mins = opts?.expiresMinutes ?? 10;
  const html = layout(`
    ${greeting(opts?.name)}
    <p style="color:#374151;font-size:14px;line-height:1.6;margin:0 0 4px">
      Your ${BRAND} verification code is:
    </p>
    ${codeBlock(code)}
    <p style="color:#9ca3af;font-size:13px;margin:0">
      Enter this code to verify your email. It expires in ${mins} minutes.
      If you didn't create an account, you can ignore this email.
    </p>
  `);

  return {
    subject: `Your ${BRAND} verification code: ${code}`,
    html,
    text: `Your ${BRAND} verification code is: ${code}\n\nEnter it to verify your email. It expires in ${mins} minutes.\n\nIf you didn't create an account, ignore this email.`,
  };
}

/* ------------------------------------------------------------------ */
/*  Organization invitation                                            */
/* ------------------------------------------------------------------ */

export function organizationInviteEmail(opts: {
  invitee: { email: string };
  inviter: { name?: string | null; email: string };
  organizationName: string;
  url: string;
}) {
  const inviterLabel = opts.inviter.name || opts.inviter.email;
  const inviterLabelHtml = htmlEscape(inviterLabel);
  const organizationNameHtml = htmlEscape(opts.organizationName);
  const html = layout(`
    <p style="color:#111827;font-size:16px;font-weight:600;margin:0 0 12px">You're invited to ${organizationNameHtml}</p>
    <p style="color:#374151;font-size:14px;line-height:1.6;margin:0 0 4px">
      ${inviterLabelHtml} invited you to collaborate on <strong>${organizationNameHtml}</strong> in ${BRAND}.
      Accept the invite to join the team and access shared projects, deployments, and servers.
    </p>
    ${ctaButton(opts.url, "Accept invitation")}
    <p style="color:#9ca3af;font-size:13px;margin:0">
      If you don't have an Openship account yet, you'll be asked to create one with this email
      (${htmlEscape(opts.invitee.email)}). The invitation expires in 7 days.
    </p>
  `);

  return {
    subject: `${inviterLabel} invited you to ${opts.organizationName} on ${BRAND}`,
    html,
    text: `${inviterLabel} invited you to ${opts.organizationName} on ${BRAND}.\n\nAccept: ${opts.url}\n\nThe invitation expires in 7 days.`,
  };
}
