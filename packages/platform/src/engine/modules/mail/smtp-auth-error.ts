/**
 * Nodemailer exposes authentication failures through structured fields when
 * possible and falls back to the SMTP response text for some transports.
 * Keep the detection in one pure helper so test sending and system sending do
 * not grow slightly different ideas of a 535.
 */
export function isSmtpAuthFailure(err: unknown): boolean {
  if (!err || typeof err !== "object") {
    return /\b535\b|5\.7\.8|authentication\s+failed|invalid\s+credentials/i.test(String(err ?? ""));
  }

  const smtpError = err as {
    code?: unknown;
    responseCode?: unknown;
    message?: unknown;
    response?: unknown;
    cause?: unknown;
  };
  if (smtpError.code === "EAUTH" || smtpError.responseCode === 535) return true;

  const detail = [smtpError.message, smtpError.response]
    .filter((value): value is string => typeof value === "string")
    .join(" ");
  if (/\b535\b|5\.7\.8|authentication\s+failed|invalid\s+credentials/i.test(detail)) {
    return true;
  }
  return smtpError.cause ? isSmtpAuthFailure(smtpError.cause) : false;
}
