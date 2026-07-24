import { z } from "zod";
import {
  runtimeTarget,
  runtimeTargetId,
  cloudRuntimeTarget,
  cloudRuntimeTargetId,
  dashboardRuntimeOrigins,
  LOCAL_WEB_URL,
} from "@repo/core";

export { runtimeTarget, runtimeTargetId, cloudRuntimeTarget, cloudRuntimeTargetId };

const DEFAULT_BETTER_AUTH_SECRET = "change-me-in-production";

/**
 * Parse a string env var as boolean. Accepts "true"/"1" → true,
 * "false"/"0"/"" → false. Defaults match the surrounding semantics.
 */
const envBool = (defaultValue: "true" | "false" | "" = "") =>
  z
    .enum(["true", "false", "1", "0", ""])
    .default(defaultValue)
    .transform((v) => v === "true" || v === "1");

/**
 * API configuration - loaded from environment variables.
 *
 * CLOUD_MODE=true enables billing, metering, and multi-tenant features.
 * Runtime URL/port values are hardcoded in @repo/core runtime targets.
 * DATABASE_URL is read directly from `process.env` by @repo/db (not
 * routed through this schema).
 */
const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),

  /* ---------- Listen port ---------- */
  /**
   * Honored when set so a SINGLE docker-compose service definition works
   * regardless of OPENSHIP_TARGET — the container binds a fixed internal
   * port and the reverse proxy maps the public domain to it. Unset, empty,
   * or invalid (non-integer / ≤0) falls back to the runtime target's port
   * (local=4000, saas=4100) via `.catch()`.
   */
  PORT: z.coerce.number().int().positive().catch(runtimeTarget.ports.api),

  /**
   * Extra origins to trust for CORS / origin-guard / auth, comma-separated.
   * The desktop app runs the dashboard on a DYNAMIC free port, so its origin
   * isn't in the static runtime-target table — Electron passes it here at
   * spawn (e.g. "http://localhost:51234,http://127.0.0.1:51234").
   */
  OPENSHIP_EXTRA_TRUSTED_ORIGINS: z.string().optional(),

  /**
   * Dashboard origin for auth redirects (desktop-login/claim, cloud-callback).
   * The desktop dashboard runs on a DYNAMIC port Electron injects here; unset
   * elsewhere → falls back to the static runtime-target dashboard URL.
   */
  OPENSHIP_LOCAL_DASHBOARD_URL: z.string().optional(),

  /**
   * Set when this instance is served on a PUBLIC URL (e.g. `openship up
   * --public-url https://ops.example.com` on a VPS). Two security effects:
   *   - zero-auth is refused outright (a network-exposed control plane must
   *     require login — the loopback guard is meaningless once a same-box
   *     reverse proxy forwards remote traffic as loopback), and
   *   - the default auth mode for a fresh install becomes "local".
   * Presence, not the value, is the signal.
   */
  OPENSHIP_PUBLIC_URL: z.string().optional(),

  /**
   * The origin THIS API is actually reachable at — used ONLY to construct
   * absolute auth/OAuth URLs (discovery issuer, authorize, token) so external
   * MCP clients get a reachable origin instead of the static `runtimeTarget.api`
   * fallback. The desktop app runs the API on a dynamic loopback port and passes
   * `http://127.0.0.1:<apiPort>` here.
   *
   * SECURITY: this is a URL-CONSTRUCTION signal only. Unlike OPENSHIP_PUBLIC_URL
   * it must NEVER feed the zero-auth / auth-mode / cookie / trustedOrigins-security
   * gates — that's the whole point (it lets desktop advertise a reachable origin
   * WITHOUT tripping `zeroAuthAllowed`'s "publicly-served" rejection).
   */
  OPENSHIP_ADVERTISED_ORIGIN: z.string().optional(),

  /**
   * Force login (no zero-auth) even in desktop DEPLOY_MODE. The CLI sets this
   * for every `openship up` — a CLI-managed instance always requires a real
   * admin account (created by the CLI's setup), unlike the Electron desktop app
   * which keeps loopback zero-auth. Presence, not value, is the signal.
   */
  OPENSHIP_REQUIRE_AUTH: envBool("false"),

  /**
   * Managed edge: at boot, install OpenResty + certbot on THIS machine and
   * route OPENSHIP_PUBLIC_URL's host → the local dashboard with a free Let's
   * Encrypt cert (reusing the app-deploy route/SSL pipes). Set by the CLI
   * wizard's "managed edge" path; off = bring-your-own reverse proxy.
   */
  OPENSHIP_MANAGED_EDGE: envBool("false"),
  /** Loopback dashboard port the managed edge proxies to (defaults 3001). */
  OPENSHIP_DASHBOARD_PORT: z.coerce.number().int().positive().catch(3001),
  /** Let's Encrypt contact email for the managed edge (defaults to the admin). */
  OPENSHIP_ACME_EMAIL: z.string().optional(),

  /* ---------- Mode ---------- */
  CLOUD_MODE: envBool("false"),
  /**
   * Openship Cloud only: hard cap on projects per user (a cloud org maps 1:1
   * to its owning SaaS user, so per-org == per-user here). Enforced at project
   * create + ensure. Self-hosted ignores this and uses the high
   * SYSTEM.PROJECTS.MAX_PER_USER safety cap instead. Default 2 for now.
   */
  CLOUD_MAX_PROJECTS_PER_USER: z.coerce.number().int().min(1).default(2),
  /**
   * Deployment mode - determines the runtime + infrastructure combination:
    *   - "docker"  (default) → Docker runtime + OpenResty routing/SSL (self-hosted)
    *   - "bare"              → Process runtime + OpenResty routing/SSL (self-hosted)
   *   - "cloud"             → Oblien cloud API for everything (auto-set when CLOUD_MODE=true)
   *   - "desktop"           → Bare runtime, no routing/SSL (desktop app)
   */
  DEPLOY_MODE: z.enum(["docker", "bare", "cloud", "desktop"]).default("docker"),

  /* ---------- Auth (Better Auth) ---------- */
  BETTER_AUTH_SECRET: z.string().default(DEFAULT_BETTER_AUTH_SECRET),
  BETTER_AUTH_COOKIE_DOMAIN: z.string().optional(),
  /**
   * Gate that ENABLES the option to toggle `authMode → "none"` (zero-auth)
   * via the settings endpoint on non-desktop deployments. The operator
   * must explicitly set this to `true` to opt in — without it, the
   * PATCH /api/system/settings endpoint refuses to accept `"none"` on
   * non-desktop deployments. This is intentional: zero-auth on a
   * network-reachable instance means anyone who can hit the API can act
   * as admin, so flipping it must be a deliberate two-step (env var +
   * settings write) rather than a single dashboard click. Desktop
   * deployments ignore this flag — zero-auth is the default there.
   */
  OPENSHIP_ALLOW_ZERO_AUTH: envBool("false"),
  /**
   * Cloud-session IP/UA pinning policy. Applied by cloudSessionAuth
   * middleware when a local instance presents a cloud_session_token.
   *
   *   - "off"            → log mismatches as warnings, allow the request.
   *                        Friendly to mobile carriers/VPN switches.
   *   - "warn" (default) → same as "off" but also emits an audit log
   *                        entry per mismatch (for SOC review).
   *   - "strict"         → 401 on IP OR User-Agent mismatch with the
   *                        IP/UA stored when the session was created.
   *                        Higher security, may break legit users that
   *                        change network/device.
   */
  CLOUD_SESSION_PINNING: z
    .enum(["off", "warn", "strict"])
    .default("warn"),

  /* ---------- OAuth Providers ---------- */
  GITHUB_CLIENT_ID: z.string().optional(),
  GITHUB_CLIENT_SECRET: z.string().optional(),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),

  /* ---------- GitHub Auth Strategy ---------- */
  /**
   * Controls how the API authenticates with GitHub:
   *   - "auto"  (default) → inferred from DEPLOY_MODE / CLOUD_MODE
   *   - "app"             → GitHub App installation tokens (cloud)
   *   - "oauth"           → Better Auth OAuth flow only (self-hosted with OAuth)
   *   - "cli"             → `gh auth login` token from the machine (local/desktop)
   *   - "token"           → static GITHUB_TOKEN env var (CI, scripts)
   */
  GITHUB_AUTH_MODE: z.enum(["auto", "app", "oauth", "cli", "token"]).default("auto"),
  /** Static GitHub personal access token - used when GITHUB_AUTH_MODE="token" */
  GITHUB_TOKEN: z.string().optional(),

  /* ---------- Redis ---------- */
  REDIS_URL: z.string().default("redis://localhost:6379"),

  /* ---------- Stripe (Cloud only) ---------- */
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),

  /* ---------- GitHub App ---------- */
  GITHUB_APP_ID: z.string().optional(),
  GITHUB_APP_SLUG: z.string().default("openship-io"),
  /** PEM private key - raw multi-line string */
  GITHUB_PRIVATE_KEY: z.string().optional(),
  /** PEM private key - base64-encoded (single-line, for env vars) */
  GITHUB_PRIVATE_KEY_BASE64: z.string().optional(),
  GITHUB_WEBHOOK_SECRET: z.string().optional(),

  /* ---------- Email (SMTP) ---------- */
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_FROM: z.string().default("Openship <noreply@openship.io>"),

  /* ---------- Network (self-hosted) ---------- */
  /**
   * Operator-controlled toggle gating trust of `x-real-ip` /
   * `x-forwarded-for` headers (MEDIUM cleanup). When the API is behind
   * a reverse proxy (openresty, nginx, traefik) that strips/rewrites
   * these headers, set true. When the API is the edge listener,
   * leave false — otherwise a malicious client can lie about its IP
   * and bypass per-IP rate limiting / audit attribution.
   *
   * Defaults false. Loopback peers ALWAYS keep header trust (local
   * dev) regardless of this flag.
   */
  TRUST_PROXY: envBool("false"),
  /**
   * Allow outbound notification webhooks to target internal/loopback/LAN hosts.
   * Default false → the SSRF guard (assertPublicUrl) runs on self-hosted too, so
   * a member can't point a channel at 127.0.0.1 / metadata / the private network.
   * Single-tenant self-hosts that intentionally notify a LAN endpoint can opt in.
   * Ignored under CLOUD_MODE (multi-tenant always guards).
   */
  NOTIFY_WEBHOOK_ALLOW_INTERNAL: envBool("false"),
  /** Public IP of the server - used for A record instructions in self-hosted mode. */
  SERVER_IP: z.string().optional(),
  /**
   * Base domain for the self-hosted instance (e.g. "example.com").
   * Deployments get a free subdomain: slug.HOST_DOMAIN (e.g. "myapp.example.com").
   * SSL is NOT auto-provisioned for these - only for custom domains.
   */
  HOST_DOMAIN: z.string().optional(),

  /* ---------- Oblien Cloud ---------- */
  OBLIEN_CLIENT_ID: z.string().optional(),
  OBLIEN_CLIENT_SECRET: z.string().optional(),
  /**
   * Shared secret we hand Oblien when registering our webhook via
   * `webhooks.create` (see `ensureOblienWebhook`). Oblien signs each delivery
   * as `X-Webhook-Signature = HMAC-SHA256(secret, rawBody)` (hex, body only —
   * no timestamp). The receiver at /api/billing/oblien-webhook verifies it in
   * constant time; missing secret → 503 (never silently accept unverified
   * traffic). CLOUD_MODE only — self-hosted never registers Oblien webhooks.
   */
  OBLIEN_WEBHOOK_SECRET: z.string().optional(),

  /* ---------- Backup destinations ---------- */
  /**
   * Allow `kind: 'local'` backup destinations. Defaults OFF everywhere
   * (including self-hosted single-operator installs) - the operator must
   * explicitly opt in with BACKUP_ALLOW_LOCAL_DESTINATION=true.
   */
  BACKUP_ALLOW_LOCAL_DESTINATION: envBool(),
  /**
   * Absolute path that bounds every `kind: 'local'` destination.
   * Endpoints must resolve to a subpath of this root. Default
   * /var/lib/openship/backups. Symlinks are resolved before the check.
   */
  BACKUP_LOCAL_ROOT: z.string().default("/var/lib/openship/backups"),

  /**
   * Colon-separated extra roots accepted for `server.sshKeyPath`. The
   * default allowlist already includes /var/lib/openship/ssh-keys and
   * /etc/openship/ssh-keys — set this for installs that keep their
   * SSH keys somewhere else.
   */
  SSH_KEY_PATH_ROOTS: z.string().default(""),

  /* ---------- Screenshots (optional) ---------- */
  SCREENSHOT_SERVICE_URL: z.string().optional(),
  CDN_UPLOAD_URL: z.string().optional(),

  /* ---------- Internal (Electron ↔ API) ---------- */
  /** Shared secret for Electron → API calls (set by desktop app on startup) */
  INTERNAL_TOKEN: z.string().optional(),

  /* ---------- Mail webmail (Zero) ---------- */
  /**
   * Base URL of the Zero webmail server reachable from openship's API.
   * The Zero server owns its branding storage and exposes
   * `/branding.json` (public) + `/admin/branding` (token-auth). Openship
   * proxies dashboard branding writes here. Can be on the same VPS as
   * iRedMail, on a separate host, or even cross-region - wherever the
   * operator runs Zero.
   */
  MAIL_WEBMAIL_URL: z.string().default("http://localhost:3030"),
  /**
   * Shared secret matching the Zero server's `BRANDING_ADMIN_TOKEN`.
   * Sent as `X-Branding-Admin-Token` on writes. Never reaches the
   * browser; openship API holds it, dashboard talks to openship.
   */
  MAIL_WEBMAIL_ADMIN_TOKEN: z.string().optional(),

  /** Enables verbose timing logs for SSH/system checks and environment detection */
  SYSTEM_DEBUG_LOGS: envBool(),

  /* ---------- Interactive terminal (xterm over WebSocket → ssh2 PTY) ---------- */
  /**
   * Idle timeout - kill a terminal session that goes this long without
   * receiving any client input (stdin bytes). Defaults to 15 minutes.
   * Bound at 1min minimum so an operator can't accidentally disable it.
   */
  TERMINAL_IDLE_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(60_000)
    .default(15 * 60_000),
  /**
   * Hard cap - terminate a session after this absolute wall-clock duration
   * regardless of activity. Defaults to 1 hour. Limits long-lived
   * sessions from accumulating across operator forgetting to close tabs.
   */
  TERMINAL_HARD_CAP_MS: z.coerce.number().int().min(60_000).default(60 * 60_000),
  /**
   * Maximum concurrent terminal sessions per user across all servers.
   * Enforced at handshake against the audit table (rows with endedAt IS
   * NULL). Defaults to 3.
   */
  TERMINAL_MAX_SESSIONS_PER_USER: z.coerce.number().int().min(1).max(50).default(3),
  /**
   * TTL for the one-shot WS handshake ticket. The dashboard requests a
   * ticket from a normal authenticated endpoint, then presents it in
   * `Sec-WebSocket-Protocol` when opening the WS. Tickets are single-use
   * and consumed by the WS server before the channel opens. Defaults to
   * 30 seconds - long enough to survive a slow handshake, short enough
   * that a leaked ticket has near-zero replay window.
   */
  TERMINAL_TICKET_TTL_MS: z.coerce.number().int().min(5_000).max(300_000).default(30_000),
  /**
   * Per-session server-side scrollback buffer cap in bytes. Every PTY
   * output chunk is appended to a ring buffer up to this size; older
   * bytes are dropped from the head when over. On resume (page reload,
   * tab swap, network blip), the WHOLE buffer is replayed to the new
   * WebSocket BEFORE any live output flows — so the user sees the
   * screen state as it was when they disconnected.
   *
   * Default 524288 bytes (512KB) ≈ 2000-3000 lines depending on width
   * and ANSI density. Bound at 16KB minimum (replay would be pointless
   * smaller) and 8MB maximum (memory budget per parked session).
   */
  TERMINAL_SCROLLBACK_BYTES: z.coerce
    .number()
    .int()
    .min(16 * 1024)
    .max(8 * 1024 * 1024)
    .default(512 * 1024),
});

type Env = z.infer<typeof envSchema>;

export const env: Env = envSchema.parse(process.env);

// Print resolution at MODULE LOAD, before any handler runs. If
// boot crashes (e.g. EADDRINUSE on listen), this still shows. The
// runtime-target row is resolved in @repo/core/runtime-config from
// OPENSHIP_TARGET; no NODE_ENV magic, no CLOUD_MODE inference here.
console.log(
  `[env] OPENSHIP_TARGET=${process.env.OPENSHIP_TARGET ?? "(unset, default local)"}  ` +
    `→ self=${runtimeTargetId} (${runtimeTarget.api})  ` +
    `cloud=${cloudRuntimeTargetId} (${cloudRuntimeTarget.api})`,
);

/**
 * Redis REQUIRED — when true the job runner, cache-store and rate-limit store
 * force their Redis-backed implementations and SKIP the reachability probe, so
 * there is NO silent in-memory fallback (which would break shared state across
 * replicas). Defaults ON whenever CLOUD_MODE is set — a multi-tenant SaaS must
 * share job queue / cache / rate-limit state across every instance. Self-hosted
 * single-box installs keep the auto-probe + in-memory fallback. Explicit
 * override: OPENSHIP_REQUIRE_REDIS=true|false (read raw so "unset" ≠ "false").
 */
const requireRedisRaw = (process.env.OPENSHIP_REQUIRE_REDIS ?? "").toLowerCase().trim();
export const REDIS_REQUIRED =
  requireRedisRaw === "true" || requireRedisRaw === "1"
    ? true
    : requireRedisRaw === "false" || requireRedisRaw === "0"
      ? false
      : env.CLOUD_MODE;

// Safety guard — never boot on a deployable target with the placeholder
// auth secret. `local` is allowed because that's pure-dev / desktop.
// The secret is a real secret in every saas-shaped deployment.
if (
  runtimeTargetId !== "local" &&
  env.BETTER_AUTH_SECRET === DEFAULT_BETTER_AUTH_SECRET
) {
  throw new Error(
    `BETTER_AUTH_SECRET must be set to a secure value when OPENSHIP_TARGET="${runtimeTargetId}".`,
  );
}

// ─── INTERNAL_TOKEN required outside desktop (CRITICAL #5) ─────────────────
//
// The internal-auth middleware fronts trusted Electron↔API endpoints
// (/setup, /desktop-auth-start). If INTERNAL_TOKEN is unset on a
// non-desktop deployment, every one of those routes silently becomes
// open. Refuse to boot.
if (env.DEPLOY_MODE !== "desktop" && !env.INTERNAL_TOKEN) {
  throw new Error(
    `INTERNAL_TOKEN is required when DEPLOY_MODE="${env.DEPLOY_MODE}". ` +
      `Set a 32+ byte random secret in the environment, or run the API in desktop mode.`,
  );
}

// ─── gh CLI auth modes are forbidden on the SaaS host ─────────────────────
//
// The multi-tenant SaaS (CLOUD_MODE=true) has no operator `gh` CLI and must
// NEVER shell out to it or read ~/.config/gh/hosts.yml. GITHUB_AUTH_MODE in
// {cli, token} forces a local-credential resolution path; combined with
// CLOUD_MODE that would run the gh subprocess / a static PAT on the shared
// host. getLocalGhToken/getLocalGhStatus/startDeviceFlow now hard-floor on
// CLOUD_MODE too, but refusing to boot makes the misconfiguration impossible
// rather than merely inert.
if (env.CLOUD_MODE && (env.GITHUB_AUTH_MODE === "cli" || env.GITHUB_AUTH_MODE === "token")) {
  throw new Error(
    `GITHUB_AUTH_MODE="${env.GITHUB_AUTH_MODE}" is not allowed when CLOUD_MODE=true. ` +
      `The SaaS host uses the GitHub App exclusively — set GITHUB_AUTH_MODE to "auto" or "app".`,
  );
}

// ─── OPENSHIP_ALLOW_ZERO_AUTH wiring (CRITICAL #4) ─────────────────────────
//
// `getAuthMode()` already gates the SETTINGS write on this flag. The
// runtime guard in authMiddleware ALSO refuses the zero-auth fallback
// unless the flag is true (desktop is exempt — zero-auth is default
// there). Logging here surfaces the misconfiguration in the boot
// banner so the operator sees it.
if (
  env.DEPLOY_MODE !== "desktop" &&
  !env.OPENSHIP_ALLOW_ZERO_AUTH &&
  env.NODE_ENV !== "test"
) {
  console.log(
    `[env] OPENSHIP_ALLOW_ZERO_AUTH=false (default) — zero-auth fallback disabled on this non-desktop instance.`,
  );
}

// ─── BETTER_AUTH_COOKIE_DOMAIN validation (HIGH F25) ──────────────────────
//
// A misconfigured cookie domain leaks the session cookie to every
// host that shares the suffix. Reject anything that doesn't look
// like ".example.com" with ≥2 labels AND end with the runtime
// target's eTLD+1.
if (env.BETTER_AUTH_COOKIE_DOMAIN) {
  validateCookieDomain(env.BETTER_AUTH_COOKIE_DOMAIN);
}

// ─── OPENSHIP_PUBLIC_URL validation ───────────────────────────────────────
//
// It's used to build absolute callback URLs handed to external services
// (GitHub webhooks) and injected into trustedOrigins. A malformed value would
// register a dead webhook and pollute the CORS allowlist with a junk origin, so
// fail-loud at boot instead of silently later (mirrors the cookie-domain guard).
if (env.OPENSHIP_PUBLIC_URL) {
  const raw = env.OPENSHIP_PUBLIC_URL.trim();
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(
      `OPENSHIP_PUBLIC_URL="${raw}" is not a valid absolute URL (expected e.g. https://ops.example.com).`,
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      `OPENSHIP_PUBLIC_URL must use http or https (got "${parsed.protocol}" in "${raw}").`,
    );
  }
}

// ─── OPENSHIP_ADVERTISED_ORIGIN validation ────────────────────────────────
// URL-construction only (see the field doc). Same fail-loud shape as
// OPENSHIP_PUBLIC_URL so a malformed origin can't produce junk discovery URLs.
if (env.OPENSHIP_ADVERTISED_ORIGIN) {
  const raw = env.OPENSHIP_ADVERTISED_ORIGIN.trim();
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(
      `OPENSHIP_ADVERTISED_ORIGIN="${raw}" is not a valid absolute URL (expected e.g. http://127.0.0.1:54777).`,
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      `OPENSHIP_ADVERTISED_ORIGIN must use http or https (got "${parsed.protocol}" in "${raw}").`,
    );
  }
}

function validateCookieDomain(raw: string): void {
  const value = raw.trim();
  if (!value.startsWith(".")) {
    throw new Error(
      `BETTER_AUTH_COOKIE_DOMAIN must start with "." (got "${raw}").`,
    );
  }
  const labels = value.slice(1).split(".").filter(Boolean);
  if (labels.length < 2) {
    throw new Error(
      `BETTER_AUTH_COOKIE_DOMAIN must have at least 2 labels (got "${raw}"). ` +
        `Single-label domains (e.g. ".com") would leak cookies to every site under that TLD.`,
    );
  }

  // Compute the runtime target's eTLD+1 (rightmost 2 labels) and
  // require the cookie domain ends with it. Avoids cross-product
  // leaks (".openship.io" on an instance whose API runs at
  // "api.example.com").
  let apiHostname: string;
  try {
    apiHostname = new URL(runtimeTarget.api).hostname;
  } catch {
    throw new Error(
      `runtimeTarget.api ("${runtimeTarget.api}") is not a valid URL — cannot validate BETTER_AUTH_COOKIE_DOMAIN.`,
    );
  }
  const apiLabels = apiHostname.split(".").filter(Boolean);
  if (apiLabels.length < 2) {
    // Localhost / single-label hosts (dev mode) — skip the suffix check.
    return;
  }
  const apiSuffix = "." + apiLabels.slice(-2).join(".");
  if (!value.endsWith(apiSuffix)) {
    throw new Error(
      `BETTER_AUTH_COOKIE_DOMAIN "${raw}" does not end with the API's eTLD+1 "${apiSuffix}". ` +
        `The cookie domain must be a parent of the API hostname.`,
    );
  }
}

// ─── Self-hosted GitHub App creds are deprecated ────────────────────────────
//
// The GitHub App private key now lives exclusively in api.openship.io
// (CLOUD_MODE=true). Self-hosted instances proxy all App-scoped operations
// through cloud-client.ts. Setting these on a self-hosted instance has no
// effect but suggests the operator hasn't seen the new flow — warn so they
// know they can clean up their .env.
if (!env.CLOUD_MODE) {
  // GITHUB_APP_SLUG is intentionally NOT in this list — it IS consumed
  // on self-hosted (by getInstallUrl in github.auth.ts to build the
  // install link the dashboard shows). GITHUB_WEBHOOK_SECRET is also NOT
  // listed: it's no longer REQUIRED (webhooks now mint + persist a
  // per-project signing secret), but it stays a valid LEGACY FALLBACK the
  // webhook verifier still accepts — so we don't nag operators to remove it.
  // The vars below ARE App-private credentials that moved to api.openship.io.
  const stale = [
    env.GITHUB_APP_ID && "GITHUB_APP_ID",
    (env.GITHUB_PRIVATE_KEY || env.GITHUB_PRIVATE_KEY_BASE64) && "GITHUB_PRIVATE_KEY",
  ].filter(Boolean);
  if (stale.length > 0) {
    console.warn(
      `[env] Self-hosted instances no longer use local GitHub App credentials. ` +
      `These env vars are ignored: ${stale.join(", ")}. ` +
      `Connect to Openship Cloud in Settings to enable App-scoped GitHub access.`,
    );
  }
}

/**
 * Trusted origins for CORS + Better Auth. Runtime-target URLs are
 * hardcoded clean origins from `@repo/core` (no trailing slashes,
 * always http(s)) so we just dedupe them — no normalization needed.
 */
const extraTrustedOrigins = (env.OPENSHIP_EXTRA_TRUSTED_ORIGINS ?? "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

export const trustedOrigins = [
  ...new Set([
    runtimeTarget.dashboard,
    runtimeTarget.api,
    // Public serving (openship up --public-url): the browser's origin is the
    // operator's public URL, so it must be trusted for CORS, the origin guard,
    // and Better Auth's login CSRF check — otherwise remote login is rejected.
    ...(env.OPENSHIP_PUBLIC_URL ? [env.OPENSHIP_PUBLIC_URL.replace(/\/+$/, "")] : []),
    ...extraTrustedOrigins,
    ...(env.NODE_ENV === "production"
      ? []
      : [LOCAL_WEB_URL, ...dashboardRuntimeOrigins]),
  ]),
];

/**
 * Dashboard origin for auth redirects (desktop-login/claim, cloud-callback).
 * Desktop injects the dynamic dashboard port via OPENSHIP_LOCAL_DASHBOARD_URL;
 * otherwise the static runtime-target dashboard URL.
 */
export const localDashboardUrl =
  env.OPENSHIP_LOCAL_DASHBOARD_URL?.trim() || runtimeTarget.dashboard;

/** Internal loopback URL for the API (used by nginx webhook proxy, etc.) */
export const internalApiUrl = `http://127.0.0.1:${env.PORT}`;

/**
 * proxy_pass target for the `/_openship/hooks/` webhook location injected into a
 * project's nginx vhost. Single source so the deploy-time and edit-time route
 * builders can't drift.
 */
export const webhookProxyTarget = `${internalApiUrl}/api/webhooks/`;
