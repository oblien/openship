/**
 * Send a welcome / verification test email from the freshly-provisioned
 * mail server to the operator's personal inbox.
 *
 * Path: nodemailer over SMTP submission against the mail VPS's public
 * endpoint (`mail.<installDomain>:465`, implicit TLS). The orchestrator
 * authenticates as `openship@<senderDomain>` — either the shared platform
 * mailbox (when no fromDomain override or it matches the install domain)
 * or a per-domain test mailbox (when fromDomain names an additional
 * domain), provisioned on demand by `ensureOpenshipTestMailbox`. SMTP
 * AUTH user is always the same address as the From header, so Postfix's
 * `reject_sender_login_mismatch` check is satisfied and amavis DKIM-signs
 * with the From-domain's key.
 *
 * History: this used to send AS `postmaster@<fromDomain>` with the
 * per-domain plaintext stored in `state.secrets.DOMAIN_ADMIN_PASSWD_PLAIN`
 * (or `state.additionalDomains[fromDomain].postmasterPassword`). That
 * dual-storage shape was the root cause of the most common failure here —
 * the plaintext we sent and the SSHA512 hash in `vmail.mailbox` could
 * drift independently. The platform mailbox primitive owns both ends of
 * its credential in a single ensure* call, so 535 auth failures become
 * REALLY rare: they imply the doveadm hash and the state-file plaintext
 * were rotated out-of-band, which we don't do anywhere.
 *
 * Why nodemailer (vs. shelling sendmail on the mail VPS via SSH):
 *   1. The connection itself is the test. A failed AUTH means broken
 *      credentials, a TLS error means broken cert, a connect timeout
 *      means the SMTP daemon is down - all surface as real, distinct
 *      errors the operator can act on. The old sendmail-via-SSH path
 *      could "succeed" with the message stuck in the local queue forever.
 *   2. Reuses the same code path the platform will use for any future
 *      transactional mail (e.g. user-invite emails, alerts), so a working
 *      welcome test proves the whole pipeline, not just the local MTA.
 *   3. Real `Message-ID` comes back from the server's `250 OK` response,
 *      not a synthetic one we made up.
 *
 * The HTML body stays minimal: single column, plain colors, no images,
 * no tracking pixels. That's the shape Gmail/Outlook/Apple Mail's spam
 * classifiers reward on day one - and it doubles as the "do as we do"
 * example the message text points operators at. We don't tell operators
 * to "wait 24-48 hours for reputation to build"; we tell them to send
 * well-formed HTML through real SMTP submission (nodemailer / AUTH on
 * 465) so DKIM signs and SPF aligns from the first message.
 */

// DEPENDENCY: `ensureOpenshipTestMailbox` is provided by
// ./test-mailbox.service, which is being introduced in a parallel agent
// run. Until that file lands, this import will fail typecheck — that's
// expected. After both agents land the project as a whole typechecks.
import nodemailer, { type Transporter } from "nodemailer";
import { decrypt } from "../../../lib/encryption";
import { sshManager } from "../../../lib/ssh-manager";
import { readState } from "../mail-state";
import { safeErrorMessage } from "@repo/core";
import {
  ensureOpenshipPlatformMailbox,
  type PlatformMailboxCreds,
} from "./platform-mailbox.service";
import { ensureOpenshipTestMailbox } from "./test-mailbox.service";

const EMAIL_RE = /^[a-z0-9._+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i;

/**
 * Submission port. 465 (implicit TLS) over 587 (STARTTLS) because:
 *   - Both are universally supported by iRedMail's Postfix.
 *   - 465 keeps the entire conversation encrypted from the first byte -
 *     no plaintext EHLO leaks the server banner before the upgrade.
 *   - Skips the STARTTLS-stripping class of MITM attacks.
 *   - One fewer state machine to debug when something goes wrong.
 */
const SUBMISSION_PORT = 465;

/**
 * The address to actually open the submission socket to.
 *
 * Queries public resolvers rather than the system stub for the reason in the
 * comment at the call site: on the mail host, `/etc/hosts` maps the mail
 * hostname to 127.0.1.1, which is useless (and wrong) from inside a container.
 * Falls back to the hostname untouched when public DNS can't answer — a remote
 * mail server reachable by name keeps working exactly as before, and a genuine
 * DNS problem still surfaces as the connect error it is, not as a lookup crash.
 */
async function resolveSubmissionAddress(host: string): Promise<string> {
  const { Resolver } = await import("node:dns/promises");
  const resolver = new Resolver();
  resolver.setServers(["1.1.1.1", "8.8.8.8"]);
  const [v4] = await resolver.resolve4(host).catch(() => [] as string[]);
  return v4 ?? host;
}

export class TestEmailError extends Error {}

export interface SendTestEmailInput {
  to: string;
  /**
   * When provided AND not equal to the install domain, the test message is
   * sent through a per-domain `openship@<fromDomain>` mailbox (provisioned
   * on demand by `ensureOpenshipTestMailbox`). That mailbox is used as
   * BOTH the SMTP AUTH user AND the From-header address — so MAIL FROM
   * matches the authenticated identity and Postfix's
   * `reject_sender_login_mismatch` check is satisfied (no more 554s).
   *
   * When absent (or equal to the install domain), falls back to the
   * shared platform mailbox `openship@<installDomain>` via
   * `ensureOpenshipPlatformMailbox`.
   *
   * The DKIM signature comes from amavis keyed by the From-domain — so a
   * per-domain test still exercises that domain's full DNS+DKIM path
   * end-to-end.
   */
  fromDomain?: string;
}

export interface SendTestEmailResult {
  to: string;
  from: string;
  messageId: string;
  /** Raw SMTP server response (`250 OK …`). Surfaced for debugging. */
  smtpResponse: string;
}

/**
 * Send the welcome / verification message.
 *
 * Identity selection:
 *   - `fromDomain` absent or equal to the install domain → AUTH+From as
 *     the shared platform mailbox `openship@<installDomain>` (sourced
 *     from `state.platformMailbox`, backfilled via
 *     `ensureOpenshipPlatformMailbox` on first run).
 *   - `fromDomain` set to an additional domain → AUTH+From as
 *     `openship@<fromDomain>`, provisioned (or reused) by
 *     `ensureOpenshipTestMailbox`.
 *
 * Either way, SMTP AUTH user equals the From-header address — that's what
 * Postfix's `reject_sender_login_mismatch` requires (we used to spoof
 * `postmaster@<fromDomain>` while auth'd as `openship@<installDomain>`
 * and got 554s).
 *
 * Submission target is always `mail.<state.domain>:465` (implicit TLS) —
 * every additional domain shares the primary install's MX (it's the only
 * hostname with an SSL cert and SMTP-AUTH configured), per the SPF/MX
 * records this module publishes.
 *
 * Throws `TestEmailError` for user-facing failures; plain `Error` for
 * SMTP/network failures with `.cause` preserved so the controller can
 * surface diagnostics.
 */
export async function sendTestEmail(
  serverId: string,
  input: SendTestEmailInput,
): Promise<SendTestEmailResult> {
  const to = input.to.trim().toLowerCase();
  if (!EMAIL_RE.test(to) || to.length > 255) {
    throw new TestEmailError("Enter a valid email address");
  }

  // fromDomain (optional) — when provided and not the install domain, we
  // provision (or reuse) `openship@<fromDomain>` and authenticate as that
  // mailbox AND send From that mailbox. SMTP AUTH user == MAIL FROM, so
  // Postfix's `reject_sender_login_mismatch` is satisfied (the old design
  // auth'd as `openship@<installDomain>` while sending FROM
  // `postmaster@<fromDomain>` and got 554'd). amavis still DKIM-signs
  // with <fromDomain>'s key because the From-domain matches.
  if (input.fromDomain && !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(input.fromDomain)) {
    throw new TestEmailError(
      `Invalid fromDomain "${input.fromDomain}" — expected a bare hostname like example.com.`,
    );
  }

  // 1. Read the install domain from state so we can decide whether
  //    `fromDomain` refers to an *additional* domain (needs its own
  //    `openship@<fromDomain>` mailbox) or just restates the install
  //    domain (use the shared platform mailbox).
  const installDomain = await sshManager.withExecutor(serverId, async (exec) => {
    const state = await readState(exec);
    if (!state || !state.domain) {
      throw new TestEmailError(
        "Mail state not found - finish the install first.",
      );
    }
    return state.domain;
  });

  // 2. Resolve creds. Both branches return the SAME shape — the SMTP AUTH
  //    user and the From-header address are ALWAYS the same `openship@<d>`
  //    address. Postfix's `reject_sender_login_mismatch` rejects MAIL FROM
  //    values that don't match the SASL-authenticated user; the old design
  //    auth'd as `openship@<installDomain>` while spoofing
  //    `postmaster@<fromDomain>` and tripped exactly that check (554).
  let creds: {
    email: string;
    password: string;
    smtpHost: string;
    smtpPort: number;
    secure: boolean;
  };
  if (input.fromDomain && input.fromDomain !== installDomain) {
    // Per-domain path: provision (or reuse) `openship@<fromDomain>`. If
    // <fromDomain> is not in vmail.domain the ensure call throws — wrap
    // into TestEmailError so the dashboard surfaces a clean 4xx instead
    // of a 500.
    try {
      const minted = await ensureOpenshipTestMailbox(serverId, input.fromDomain);
      creds = {
        email: minted.email,
        password: minted.password,
        smtpHost: minted.smtpHost,
        smtpPort: minted.smtpPort,
        secure: minted.secure,
      };
    } catch (err) {
      throw new TestEmailError(
        `Could not provision openship@${input.fromDomain}: ${safeErrorMessage(err)}`,
      );
    }
  } else {
    // Install-domain path: the shared platform mailbox.
    // Fast path is a pure state-file read; first-run / drift backfills
    // via ensureOpenshipPlatformMailbox.
    const cached = await sshManager.withExecutor(serverId, async (exec) => {
      const state = await readState(exec);
      return state?.platformMailbox;
    });
    if (cached && cached.email && cached.password) {
      // Decrypt at-rest password (AES-256-GCM ciphertext on the happy path,
      // legacy plaintext on pre-encryption installs).
      let smtpPassword: string;
      try {
        smtpPassword = decrypt(cached.password);
      } catch {
        console.warn(
          `[sendTestEmail] serverId=${serverId} platform mailbox password is legacy plaintext — rotate via /mail/admin/${serverId}/platform-mailbox/rotate to encrypt at rest.`,
        );
        smtpPassword = cached.password;
      }
      creds = {
        email: cached.email,
        password: smtpPassword,
        smtpHost: cached.smtpHost,
        smtpPort: 465,
        secure: true,
      };
    } else {
      const minted: PlatformMailboxCreds =
        await ensureOpenshipPlatformMailbox(serverId);
      creds = {
        email: minted.email,
        password: minted.password,
        smtpHost: minted.smtpHost,
        smtpPort: minted.smtpPort,
        secure: minted.secure,
      };
    }
  }

  // Auth user == From address — no spoof, no MAIL FROM / SASL mismatch.
  const authUser = creds.email;
  const smtpHost = creds.smtpHost;
  const smtpPassword = creds.password;
  const from = creds.email;
  const senderDomain = creds.email.split("@")[1] || "";

  // ── SMTP submission ─────────────────────────────────────────────────
  //
  // verify() runs CONNECT → EHLO → TLS check → AUTH dry-run, so a bad
  // cert, wrong password, or blocked port surfaces here before we burn
  // a queue slot. sendMail() then does MAIL FROM / RCPT TO / DATA / QUIT
  // and returns the server's actual 250 response.
  // Dial the address PUBLIC DNS gives, not whatever the local resolver
  // returns. On the mail host itself `/etc/hosts` carries the
  // `127.0.1.1 mail.<domain>` line the hostname step writes, and a
  // containerized API inherits that answer through the host's resolver —
  // then connects to 127.0.1.1 inside its OWN namespace, where nothing
  // listens, and every send fails with `ECONNREFUSED 127.0.1.1:465` while
  // Postfix is healthy on 0.0.0.0:465. `servername` keeps TLS validating
  // against the hostname, so certificate checking is unchanged.
  const connectHost = await resolveSubmissionAddress(smtpHost);
  const transporter: Transporter = nodemailer.createTransport({
    host: connectHost,
    tls: { servername: smtpHost },
    port: SUBMISSION_PORT,
    secure: true,
    auth: { user: authUser, pass: smtpPassword },
    // Timeouts kept short - the dashboard awaits this synchronously and
    // the operator is staring at a "Send test" spinner. If the mail VPS
    // takes longer than 15 s for AUTH, something is wrong and we want
    // the surface error, not the hang.
    connectionTimeout: 15_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });

  try {
    await transporter.verify();
  } catch (err) {
    // With the platform-mailbox primitive owning both ends of the
    // credential, a 535 here should be REALLY rare — it implies the
    // doveadm hash in `vmail.mailbox` and the plaintext in
    // `state.platformMailbox` got out of sync via some path that bypassed
    // ensureOpenshipPlatformMailbox (manual psql update, restored state
    // file from a different generation, etc.). Tell operators how to
    // realign both ends in a single call.
    const message = safeErrorMessage(err);
    const looksLikeAuthFailure =
      /\b535\b/.test(message) ||
      /5\.7\.8/.test(message) ||
      /authentication\s+failed/i.test(message) ||
      /invalid\s+credentials/i.test(message);
    const suffix = looksLikeAuthFailure
      ? ` - the platform mailbox credential and the Dovecot hash appear to have drifted. Click "Rotate platform mailbox password" in the Mail admin panel (calls ensureOpenshipPlatformMailbox with { rotate: true }) to refresh both ends atomically, then retry.`
      : ``;
    throw wrapSmtpError(
      err,
      `SMTP submission check failed against ${smtpHost}:${SUBMISSION_PORT}${suffix}`,
    );
  }

  let info: { messageId: string; response: string };
  try {
    info = await transporter.sendMail({
      // Personal-feeling display name + plain reply path keep the
      // envelope from reading as machine-generated bulk. Reply-To at
      // postmaster@<domain> gives the recipient a real human path back.
      from: { name: senderDomain, address: from },
      to,
      replyTo: `postmaster@${senderDomain}`,
      // Short, neutral subject. The old "is live on your mail server"
      // tripped content filters that flag system-diagnostic phrasing on
      // new sender reputations.
      subject: `Test from ${senderDomain}`,
      text: plainTextBody({ from, domain: senderDomain }),
      html: htmlBody({ from, domain: senderDomain }),
      // No X-Mailer / X-Bulk markers — both classify as automation.
      // Date / Message-ID / MIME boundaries are filled by nodemailer
      // against the sender domain automatically.
    });
  } catch (err) {
    throw wrapSmtpError(err, `Mail server accepted auth but rejected delivery`);
  } finally {
    transporter.close();
  }

  return {
    to,
    from,
    messageId: info.messageId,
    smtpResponse: info.response,
  };
}

// ─── Error helpers ──────────────────────────────────────────────────────────

function wrapSmtpError(err: unknown, prefix: string): Error {
  const message = safeErrorMessage(err);
  const wrapped = new Error(`${prefix}: ${message}`);
  if (err instanceof Error) {
    (wrapped as Error & { cause?: unknown }).cause = err;
  }
  return wrapped;
}

// ─── Message composition ─────────────────────────────────────────────────────

/**
 * Body templates — written to read like a real one-off message a human
 * sent, not a system diagnostic. Spam filters score on content tone as
 * much as on auth: phrases like "your mail server", "stay out of spam",
 * "DKIM / SPF aligned", "third-party relay", lists of advice, and
 * uppercase TLAs all classify hard against new sender reputations.
 *
 * What this template avoids on purpose:
 *   - The word "spam" anywhere in subject or body
 *   - Jargon (MTA, DKIM, SPF, port 465, AUTH/DATA)
 *   - Long advisory sections — recipients of a test email don't need a
 *     deliverability tutorial; that lives in the dashboard
 *   - Marketing-style CTAs ("Wire it into your app", "Add more mailboxes")
 *   - Branded banners or ALL-CAPS eyebrows that read promotional
 *
 * What it keeps:
 *   - One short paragraph, conversational tone, present tense
 *   - Plain text + matching HTML (high text:HTML ratio is healthy)
 *   - No images, no tracking pixels, no external resources
 *   - Single column, system-font stack, neutral colors
 */

function plainTextBody(args: { from: string; domain: string }): string {
  const { domain } = args;
  return [
    `Hi,`,
    ``,
    `This is a test from ${domain}. If you're reading it, the message went`,
    `through cleanly.`,
    ``,
    `You can reply to this address — postmaster@${domain} will reach a`,
    `real inbox on the server.`,
    ``,
    `Thanks,`,
    `${domain}`,
  ].join("\r\n");
}

function htmlBody(args: { from: string; domain: string }): string {
  const { domain } = args;
  // Conservative HTML: tables for client compat, no images, no external
  // resources, system fonts only. Text:HTML ratio is intentionally high.
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(domain)}</title>
  </head>
  <body style="margin:0;padding:0;background:#ffffff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1a1a1a;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;">
      <tr>
        <td align="left" style="padding:24px 24px 0 24px;">
          <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;">
            <tr>
              <td style="padding:0;font-size:15px;line-height:1.6;color:#1a1a1a;">
                <p style="margin:0 0 16px;">Hi,</p>
                <p style="margin:0 0 16px;">This is a test from <strong>${escapeHtml(domain)}</strong>. If you're reading it, the message went through cleanly.</p>
                <p style="margin:0 0 16px;">You can reply to this address &mdash; <a href="mailto:postmaster@${escapeHtml(domain)}" style="color:#1a1a1a;text-decoration:underline;">postmaster@${escapeHtml(domain)}</a> will reach a real inbox on the server.</p>
                <p style="margin:0 0 4px;">Thanks,</p>
                <p style="margin:0;">${escapeHtml(domain)}</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
