/**
 * Shared mail-provider presets — one source of truth for both the mail app's
 * "Connect existing" webmail wizard (IMAP + SMTP) and the instance SMTP
 * settings (SMTP only). They're host/port templates that prefill the form; the
 * user still supplies credentials. `hint` is the inline doc for what credential
 * to paste. `sendOnly` transactional relays (Resend, SES, SendGrid, Mailgun,
 * Postmark) have no IMAP mailbox to read from.
 *
 * Brand mark: `logo` is a simpleicons slug; `logoSrc` is an explicit logo URL
 * (takes precedence). Several brands (AWS, SendGrid, Postmark, Fastmail) aren't
 * on simpleicons, so they use the favicon service — the same real-logo source
 * AppLogo already uses for Convex. AppLogo falls back to a neutral glyph if a
 * mark is missing/offline.
 */

/** Real brand logo via the favicon service (used where simpleicons has no mark). */
const brandLogo = (domain: string): string =>
  `https://www.google.com/s2/favicons?domain=${domain}&sz=128`;

export type MailProviderId =
  | "custom"
  | "resend"
  | "ses"
  | "oracle"
  | "sendgrid"
  | "mailgun"
  | "postmark"
  | "gmail"
  | "fastmail";

export interface MailProvider {
  id: MailProviderId;
  label: string;
  /** simpleicons slug for the brand mark (optional; falls back to a glyph). */
  logo?: string;
  /** Explicit brand-logo URL — wins over `logo`. For brands not on simpleicons. */
  logoSrc?: string;
  /** How the API tags this backend ("ses" is a UI hint; otherwise "custom"). */
  backendProvider: "ses" | "custom";
  imapHost: string;
  imapPort: number;
  smtpHost: string;
  smtpPort: number;
  /** Send-only relay — no IMAP mailbox to read from. */
  sendOnly?: boolean;
  /** Fixed SMTP username some relays require (prefilled on select). */
  user?: string;
  /** Short "what to paste" hint shown when this provider is selected. */
  hint?: string;
}

export const MAIL_PROVIDERS: readonly MailProvider[] = [
  {
    id: "custom",
    label: "Custom",
    backendProvider: "custom",
    imapHost: "",
    imapPort: 993,
    smtpHost: "",
    smtpPort: 465,
  },
  {
    id: "gmail",
    label: "Gmail",
    logo: "gmail",
    backendProvider: "custom",
    imapHost: "imap.gmail.com",
    imapPort: 993,
    smtpHost: "smtp.gmail.com",
    smtpPort: 465,
    hint: "Use an app password (Google Account → Security → App passwords) with 2FA on — not your login password.",
  },
  {
    id: "ses",
    label: "Amazon SES",
    logoSrc: brandLogo("aws.amazon.com"),
    backendProvider: "ses",
    sendOnly: true,
    imapHost: "",
    imapPort: 993,
    smtpHost: "email-smtp.us-east-1.amazonaws.com",
    smtpPort: 587,
    hint: "Use the SMTP credentials from the SES console (an IAM SMTP user). Change the region in the host if yours differs.",
  },
  {
    id: "oracle",
    label: "Oracle Cloud",
    logoSrc: brandLogo("oracle.com"),
    backendProvider: "custom",
    sendOnly: true,
    imapHost: "",
    imapPort: 993,
    smtpHost: "smtp.email.us-ashburn-1.oci.oraclecloud.com",
    smtpPort: 587,
    hint: "OCI Email Delivery: generate SMTP credentials (Email Delivery → SMTP Credentials) and use them here. Change the region in the host if yours differs.",
  },
  {
    id: "resend",
    label: "Resend",
    logo: "resend",
    backendProvider: "custom",
    sendOnly: true,
    imapHost: "",
    imapPort: 993,
    smtpHost: "smtp.resend.com",
    smtpPort: 465,
    user: "resend",
    hint: 'Username is "resend"; paste your Resend API key as the password.',
  },
  {
    id: "sendgrid",
    label: "SendGrid",
    logoSrc: brandLogo("sendgrid.com"),
    backendProvider: "custom",
    sendOnly: true,
    imapHost: "",
    imapPort: 993,
    smtpHost: "smtp.sendgrid.net",
    smtpPort: 587,
    user: "apikey",
    hint: 'Username is "apikey"; paste your SendGrid API key as the password.',
  },
  {
    id: "mailgun",
    label: "Mailgun",
    logo: "mailgun",
    backendProvider: "custom",
    sendOnly: true,
    imapHost: "",
    imapPort: 993,
    smtpHost: "smtp.mailgun.org",
    smtpPort: 587,
    hint: "Use your Mailgun SMTP credentials (postmaster@your-domain + its SMTP password).",
  },
  {
    id: "postmark",
    label: "Postmark",
    logoSrc: brandLogo("postmarkapp.com"),
    backendProvider: "custom",
    sendOnly: true,
    imapHost: "",
    imapPort: 993,
    smtpHost: "smtp.postmarkapp.com",
    smtpPort: 587,
    hint: "Use your Postmark Server API token as BOTH the username and the password.",
  },
  {
    id: "fastmail",
    label: "Fastmail",
    logoSrc: brandLogo("fastmail.com"),
    backendProvider: "custom",
    imapHost: "imap.fastmail.com",
    imapPort: 993,
    smtpHost: "smtp.fastmail.com",
    smtpPort: 465,
    hint: "Create an app password in Fastmail → Settings → Privacy & Security.",
  },
];

export const MAIL_PROVIDER_IDS = MAIL_PROVIDERS.map((p) => p.id);

export function mailProvider(id: MailProviderId): MailProvider {
  return MAIL_PROVIDERS.find((p) => p.id === id) ?? MAIL_PROVIDERS[0];
}

/** Best-guess the provider whose SMTP host matches a saved config (else custom). */
export function matchSmtpProvider(smtpHost: string | null | undefined): MailProviderId {
  const h = (smtpHost ?? "").trim().toLowerCase();
  if (!h) return "custom";
  const hit = MAIL_PROVIDERS.find((p) => p.id !== "custom" && p.smtpHost && h === p.smtpHost);
  return hit?.id ?? "custom";
}
