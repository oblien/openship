import { lookup as dnsLookup } from "node:dns/promises";
import nodemailer, { type Transporter } from "nodemailer";
import { env } from "../config/env";
import { safeErrorMessage, withTimeout } from "@repo/core";
import { repos } from "@repo/db";
import { cloudClient } from "./cloud/client";
import { decrypt } from "./encryption";

/**
 * Email sender with three transport sources, tried in this order for "auto":
 *
 *   1. Operator-configured instance SMTP (`instance_settings.smtp*`, set in
 *      Settings → Email). The deliberate, instance-wide transport for ALL
 *      system mail — password reset, verification, invites, notifications.
 *      Password decrypted from `smtpPasswordEncrypted`.
 *   2. The provisioned platform mailbox on this instance's mail server
 *      (`openship@<state.domain>`), via `ensureOpenshipPlatformMailbox`.
 *   3. Static env-configured SMTP (SMTP_HOST/USER/PASS) — deployment fallback.
 *
 * Self-hosted instances without any source no-op gracefully — email
 * features (verification, password reset, invitations) are simply
 * disabled.
 *
 * `smtpEnabled` exported for backward compat: true when ANY source
 * COULD deliver a message. Callers gated on this still work; new code
 * should prefer `await canSendMail()` for a fresh runtime check.
 */

export type SendMailSource = "platform" | "cloud" | "auto";

export type SendMailOptions = {
  to: string;
  subject: string;
  html: string;
  text?: string;
  /**
   * Preferred transport source. Default "auto" — uses the platform
   * mailbox when provisioned, otherwise falls back to env-configured
   * SMTP. "platform" forces platform (returns silently if unavailable).
   * "cloud" routes via the SaaS invitation-relay endpoint on a local
   * instance (requires `organizationId`), and uses the SaaS's own
   * env/platform transport when run on the SaaS itself.
   */
  preferSource?: SendMailSource;
  /**
   * Organization ID for the cloud relay path. Required when
   * `preferSource === "cloud"` and we are NOT the SaaS — the cloudClient
   * uses it to resolve the org owner's cloud session token. Ignored on
   * other paths.
   */
  organizationId?: string;
};

// ─── Env-based transport (singleton) ─────────────────────────────────────────

/** True when env SMTP credentials are all present. */
const envSmtpConfigured = !!(env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASS);

const envTransport: Transporter | null = envSmtpConfigured
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

const envFrom = env.SMTP_FROM;

// ─── Platform transport (cached briefly per serverId) ────────────────────────

interface CachedPlatformTransport {
  transport: Transporter;
  from: string;
  fetchedAt: number;
}

const PLATFORM_TRANSPORT_TTL_MS = 60_000;
const platformTransportCache = new Map<string, CachedPlatformTransport>();

/**
 * Resolving the platform mailbox SSHes into the mail server, so a server that is
 * slow, unreachable, or mid-install costs seconds per attempt. Two guards:
 *
 *   - a NEGATIVE cache, so one failure isn't re-probed by every subsequent
 *     caller (`GET /system/settings/email` is polled by the UI — without this a
 *     broken mail install made every read pay the full SSH timeout, ~23s each,
 *     and logged the same warning every time);
 *   - a hard time budget, so even a first attempt can't hold a read request
 *     open indefinitely. Mail sending has its own retries; a read that can't
 *     answer in time reports "no platform transport", which is the truth as far
 *     as this request is concerned.
 */
const PLATFORM_TRANSPORT_FAILURE_TTL_MS = 60_000;
const PLATFORM_ENSURE_TIMEOUT_MS = 8_000;
const platformTransportFailures = new Map<string, number>();

/**
 * `ensureOpenshipPlatformMailbox` reports `mail.<domain>` as the platform
 * mailbox's SMTP host - correct for an external mail client, and correct
 * for THIS process too when the api runs bare on the mail server box. But
 * when containerized, that hostname commonly resolves to a loopback address
 * via the HOST's own `/etc/hosts` self-entry (e.g. Ubuntu's default
 * `127.0.1.1 <hostname>`) - meaningful only in the host's network
 * namespace, not the container's. Connecting there fails immediately with
 * ECONNREFUSED before ever reaching Postfix.
 *
 * Detected generically (not by hardcoding any domain): resolve the reported
 * host and check if it's loopback. If so, and we have a working container
 * -> host bridge address (the same one the SSH manager already uses to
 * reach this box from inside a container), reconnect through that instead.
 * A genuinely remote mail server resolves to a real address and is passed
 * through untouched.
 */
async function resolveContainerReachableSmtpHost(reportedHost: string): Promise<string> {
  const bridgeHost = process.env.OPENSHIP_HOST_SSH_HOST?.trim();
  if (!bridgeHost) return reportedHost;
  try {
    const { address } = await dnsLookup(reportedHost);
    const isLoopback = address === "::1" || address.startsWith("127.");
    if (!isLoopback) return reportedHost;
  } catch {
    // Unresolvable - fall through and let nodemailer's own lookup fail with
    // its normal error rather than silently substituting a guess.
    return reportedHost;
  }
  return bridgeHost;
}

/**
 * Locate the active mail server and (re)build its platform-mailbox
 * transport. Returns null if no mail server is provisioned, or if the
 * ensure*-call throws (we don't want a transient mail-server fault to
 * crash the caller; the env fallback will be tried).
 *
 * Cached for 60s per serverId so we don't hit ensure* on every send.
 */
async function getPlatformTransport(): Promise<{
  transport: Transporter;
  from: string;
} | null> {
  // `@repo/db` is universal (every controller / service / repo consumer
  // already loads it eagerly at boot via `db = await createDb()`), so
  // a dynamic import buys nothing — kept static for clarity. The ONLY
  // dynamic import in this file is `platform-mailbox.service` below,
  // because THAT module pulls in the local-only SSH manager chain that
  // shouldn't load on CLOUD_MODE.
  let mailServers: Array<{ serverId: string; installedAt: Date | null }>;
  try {
    mailServers = (await repos.mailServer.list()) as Array<{
      serverId: string;
      installedAt: Date | null;
    }>;
  } catch (err) {
    console.warn("[mail] mail-server lookup failed:", err);
    return null;
  }
  // ONLY a finished install can have a platform mailbox. Falling back to the
  // first row meant a half-installed mail server (row present, `installedAt`
  // null) sent every caller down the SSH path to fail on "Mail state not found —
  // finish the mail install", which is exactly the state that was costing a
  // polled settings read ~23s.
  const installed = mailServers.find((m) => m.installedAt != null);
  if (!installed) return null;

  const cacheKey = installed.serverId;
  const cached = platformTransportCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < PLATFORM_TRANSPORT_TTL_MS) {
    return { transport: cached.transport, from: cached.from };
  }
  const failedAt = platformTransportFailures.get(cacheKey);
  if (failedAt && Date.now() - failedAt < PLATFORM_TRANSPORT_FAILURE_TTL_MS) {
    return null; // known-bad within the window — don't re-probe (or re-log)
  }

  try {
    const { ensureOpenshipPlatformMailbox } = await import(
      "../modules/mail/admin/platform-mailbox.service"
    );
    const creds = await withTimeout(
      ensureOpenshipPlatformMailbox(installed.serverId),
      PLATFORM_ENSURE_TIMEOUT_MS,
      `platform mailbox lookup on ${installed.serverId}`,
    );
    const smtpHost = await resolveContainerReachableSmtpHost(creds.smtpHost);
    const transport = nodemailer.createTransport({
      host: smtpHost,
      port: creds.smtpPort,
      secure: creds.secure,
      auth: {
        user: creds.email,
        pass: creds.password,
      },
      // When smtpHost got rewritten to the container->host bridge address,
      // the TCP connection no longer matches the certificate's name (it's
      // issued for the mail server's real hostname, e.g. mail.<domain>) -
      // pin SNI/cert verification to the ORIGINAL hostname so TLS still
      // validates against the right name while the socket itself reaches a
      // container-routable address.
      ...(smtpHost !== creds.smtpHost ? { tls: { servername: creds.smtpHost } } : {}),
    });
    const entry: CachedPlatformTransport = {
      transport,
      from: creds.from,
      fetchedAt: Date.now(),
    };
    platformTransportCache.set(cacheKey, entry);
    platformTransportFailures.delete(cacheKey);
    return { transport, from: creds.from };
  } catch (err) {
    // Logged once per failure window (see the negative cache above) instead of
    // on every request.
    platformTransportFailures.set(cacheKey, Date.now());
    console.warn(
      `[mail] platform mailbox unavailable on ${installed.serverId}; using the next transport ` +
        `(retrying in ${PLATFORM_TRANSPORT_FAILURE_TTL_MS / 1000}s): ${safeErrorMessage(err)}`,
    );
    return null;
  }
}

/** Drop the cached platform transport + failure marker for a mail server, so the
 *  next send/read re-probes immediately instead of waiting out the window. Call
 *  after an install/repair finishes. */
export function invalidatePlatformTransport(serverId?: string): void {
  if (!serverId) {
    platformTransportCache.clear();
    platformTransportFailures.clear();
    return;
  }
  platformTransportCache.delete(serverId);
  platformTransportFailures.delete(serverId);
}

// ─── Instance SMTP transport (operator-configured, DB-backed) ────────────────

const INSTANCE_TRANSPORT_TTL_MS = 60_000;
let instanceTransportCache: { transport: Transporter; from: string | undefined } | null = null;
let instanceTransportCheckedAt = 0;

/**
 * Operator-configured SMTP from `instance_settings` (Settings → Email). The
 * deliberate, instance-wide transport for ALL system mail — the highest
 * priority source in getActiveTransport.
 *
 * The password is decrypted from `smtpPasswordEncrypted`; a decrypt failure
 * (e.g. rotated ENCRYPTION_KEY) DISABLES this source (returns null) rather
 * than throwing, so it can't brick every outbound email. Result is cached
 * 60s (positive AND negative), invalidated on save via
 * invalidateInstanceTransportCache().
 */
async function getInstanceTransport(): Promise<{
  transport: Transporter;
  from: string | undefined;
} | null> {
  // Self-hosted only. On the SaaS (CLOUD_MODE) a stray instance_settings SMTP
  // row must never override the platform's own multi-tenant transport.
  if (env.CLOUD_MODE) return null;

  const now = Date.now();
  if (now - instanceTransportCheckedAt < INSTANCE_TRANSPORT_TTL_MS) {
    return instanceTransportCache; // may be null (cached "not configured")
  }
  instanceTransportCheckedAt = now;
  instanceTransportCache = null;

  let settings: Awaited<ReturnType<typeof repos.instanceSettings.get>>;
  try {
    settings = await repos.instanceSettings.get();
  } catch (err) {
    console.warn("[mail] instance-settings lookup failed:", err);
    return null;
  }

  const host = settings?.smtpHost?.trim();
  const user = settings?.smtpUser?.trim();
  const sealed = settings?.smtpPasswordEncrypted;
  if (!host || !user || !sealed) return null;

  let pass: string;
  try {
    pass = decrypt(sealed);
  } catch (err) {
    console.warn(
      "[mail] instance SMTP password failed to decrypt - disabling instance transport:",
      err,
    );
    return null;
  }

  const port = settings?.smtpPort ?? 587;
  const transport = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
  });
  instanceTransportCache = { transport, from: settings?.smtpFrom?.trim() || user };
  return instanceTransportCache;
}

/**
 * Drop the cached instance transport so the next send re-reads
 * `instance_settings`. Call after saving the SMTP config.
 */
export function invalidateInstanceTransportCache(): void {
  instanceTransportCache = null;
  instanceTransportCheckedAt = 0;
}

/**
 * Send a verification email through the operator's configured instance SMTP.
 * Unlike sendMail (which swallows failures), this THROWS the real transport
 * error so the Settings → Email "Send test" button can surface it. Throws if
 * instance SMTP isn't configured.
 */
export async function sendInstanceTestEmail(to: string): Promise<void> {
  const active = await getInstanceTransport();
  if (!active) {
    throw new Error("Instance SMTP is not configured.");
  }
  await active.transport.sendMail({
    from: active.from,
    to,
    subject: "Openship SMTP test",
    text:
      "This is a test message from your Openship instance SMTP configuration. " +
      "If you received it, outbound email (password resets, invites, notifications) works.",
  });
}

// ─── Public surface ──────────────────────────────────────────────────────────

/**
 * Best-effort module-load flag — true if env SMTP is configured OR a
 * platform mailbox is potentially available at runtime.
 *
 * Better Auth needs callbacks wired/unwired at module-load time, so we
 * default this to `true` whenever the install is provisioned (i.e. the
 * mail server / platform mailbox may exist by the time invites are
 * sent). Pure-zero-state instances (no env vars AND code knows a mail
 * server can't appear) can be detected via `canSendMail()` at runtime.
 *
 * `requireEmailVerification` should NOT be derived from this — use
 * `requireEmailVerificationStrict` (env-only) so users aren't locked
 * out when the platform transport drops mid-signup.
 */
export const smtpEnabled = true; // callbacks wired; runtime decides delivery

/**
 * Stricter env-only flag for gating `requireEmailVerification`. Avoids
 * the lockout case where the platform mailbox temporarily fails and a
 * signup can't complete because no verification email got out.
 */
export const requireEmailVerificationStrict = envSmtpConfigured;

/** Runtime check — true if any source could currently deliver. */
export async function canSendMail(): Promise<boolean> {
  if (envSmtpConfigured) return true;
  if (await getInstanceTransport()) return true;
  const platform = await getPlatformTransport();
  return platform !== null;
}

interface ActiveTransport {
  transport: Transporter;
  from: string | undefined;
  source: "instance" | "platform" | "env";
}

/**
 * Ordered list of transports to try for this send, best first. sendMail walks
 * the chain and fails over to the next source when a send THROWS — so a
 * mistyped instance-SMTP password can't brick all mail (password resets,
 * verification) when a mail-server mailbox or env transport is also available.
 *
 * The operator-configured instance SMTP always LEADS when set — that's why it
 * powers team invites too, not just resets (invites call preferSource="platform",
 * but the deliberate global transport should still win). Order:
 *
 *   instance (if set) → platform mailbox → env
 *
 * For preferSource="platform" env is dropped (branded invites shouldn't
 * silently fall back to a generic env sender); instance + platform still apply.
 * "cloud" never reaches here on a local instance (sendMail short-circuits to
 * the relay first); on the SaaS it behaves like "auto".
 */
async function getTransportChain(
  preferSource: SendMailSource = "auto",
): Promise<ActiveTransport[]> {
  const chain: ActiveTransport[] = [];
  const instance = await getInstanceTransport();
  if (instance) chain.push({ transport: instance.transport, from: instance.from, source: "instance" });
  const platform = await getPlatformTransport();
  if (platform) chain.push({ transport: platform.transport, from: platform.from, source: "platform" });
  if (preferSource !== "platform" && envTransport) {
    chain.push({ transport: envTransport, from: envFrom, source: "env" });
  }
  return chain;
}

/** Send an email. No-ops with a warning when no transport is available; fails
 *  over across the transport chain when a send throws. */
export async function sendMail(opts: SendMailOptions): Promise<void> {
  const preferSource = opts.preferSource ?? "auto";

  // Cloud relay branch — only meaningful on a local self-hosted instance.
  // When CLOUD_MODE=true we ARE the SaaS, so "cloud" falls through to the
  // normal transport selection (the SaaS has its own infra mailer).
  if (preferSource === "cloud" && !env.CLOUD_MODE) {
    if (!opts.organizationId) {
      console.warn(
        "[mail] preferSource=cloud requires organizationId - skipping email to",
        opts.to,
      );
      return;
    }
    // cloud-client is dual-side (local outbound → SaaS) with no local-
    // only side effects on import, so static import is fine. Cargo-cult
    // comment about matching "platform-transport pattern" was wrong —
    // that one IS local-only, this one isn't.
    const result = await cloudClient({
      organizationId: opts.organizationId,
    }).sendInvitation({
      to: opts.to,
      subject: opts.subject,
      html: opts.html,
      text: opts.text ?? stripHtmlForText(opts.html),
    });
    if (!result.ok) {
      console.warn(
        `[mail] cloud invitation relay failed for org=${opts.organizationId}: ${result.error}`,
      );
    }
    return;
  }

  const chain = await getTransportChain(preferSource);
  if (chain.length === 0) {
    console.warn(
      `[mail] no transport configured (preferSource=${preferSource}) - skipping email to`,
      opts.to,
    );
    return;
  }

  // Try each transport in priority order; fail over to the next on a send
  // error so one broken source (e.g. wrong instance-SMTP creds) doesn't block
  // delivery when another can carry it. Throw only when every source fails.
  let lastErr: unknown = null;
  for (let i = 0; i < chain.length; i++) {
    const active = chain[i];
    try {
      await active.transport.sendMail({
        from: active.from,
        to: opts.to,
        subject: opts.subject,
        html: opts.html,
        ...(opts.text ? { text: opts.text } : {}),
      });
      return;
    } catch (err) {
      lastErr = err;
      const more = i < chain.length - 1;
      console.warn(
        `[mail] send via ${active.source} transport failed${more ? " - trying next source" : ""}:`,
        err,
      );
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("All mail transports failed");
}

/**
 * Minimal HTML → plaintext fallback for the cloud relay when a caller
 * supplied only HTML. The SaaS endpoint requires `text` (it never sees
 * the rendered HTML beyond passthrough), so we collapse tags so the
 * payload still validates.
 */
function stripHtmlForText(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Invalidate the cached platform transport. Call after a mail-server
 * rotate / uninstall so the next sendMail re-runs ensure* and picks up
 * fresh creds (or correctly drops back to env).
 */
export function invalidatePlatformTransportCache(): void {
  platformTransportCache.clear();
}
