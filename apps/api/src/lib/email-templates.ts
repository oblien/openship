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
  return `<p style="color:#111;font-size:15px;margin:0 0 16px">Hi ${name || "there"},</p>`;
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
