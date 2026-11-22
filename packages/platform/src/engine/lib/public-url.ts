/**
 * The single source of truth for "how is THIS instance addressed from the
 * public internet" — so webhook callbacks, and anything else that must hand an
 * external service a URL back to us, stop falling back to a hardcoded
 * `runtimeTarget.api` (http://localhost:4000 on a self-hosted box).
 *
 * Topology (self-hosted, `openship up --public-url https://ops.example.com`):
 * the managed edge routes the public host to the DASHBOARD (Next, port 3001);
 * the API binds to loopback and is reachable from outside ONLY through the
 * dashboard's same-origin proxy at `/api/proxy/*`, which strips that prefix and
 * forwards the rest to `http://127.0.0.1:4000/*`
 * (apps/dashboard/src/app/api/proxy/[...path]/route.ts). So the API's public
 * base is `<public-url>/api/proxy`, and a public API path `/api/x` is reached
 * at `<public-url>/api/proxy/api/x`.
 *
 * When OPENSHIP_PUBLIC_URL is unset (cloud, or a dev box) everything falls back
 * to `runtimeTarget.api` / `runtimeTarget.dashboard`, preserving today's behavior.
 */

import { DEFAULT_GIT_PROVIDER } from "@repo/core";
import { reportCaughtError as observeCaughtError } from "@repo/core/diagnostics";
import { env, runtimeTarget, localDashboardUrl } from "../config/env";
import { repos } from "@repo/db";

/**
 * Dashboard same-origin proxy mount. Fixed contract with the dashboard route at
 * apps/dashboard/src/app/api/proxy/[...path] (baked into the release build via
 * NEXT_PUBLIC_API_PROXY). The API is only publicly reachable beneath it.
 */
const SAME_ORIGIN_PROXY_PREFIX = "/api/proxy";

const SELF_APP_SLUG = "openship";

/**
 * DB-derived public URL of the self-deployed control-plane app's PRIMARY domain.
 * Warmed by `refreshSelfAppPublicUrl()` (boot reconcile + self-register + domain
 * edits). Lets invite links / OIDC pages use the domain the operator added in
 * the Domains tab WITHOUT a restart, once no `--public-url` env seed is set.
 *
 * SECURITY: this is used ONLY to CONSTRUCT URLs. It must never feed the
 * auth-mode / zero-auth / cookie / trustedOrigins gates — those stay env-only.
 */
let cachedSelfAppUrl: string | null = null;
let cacheGeneration = 0;

/** Normalized public URL (no trailing slash): env seed wins, else the self-app's
 *  verified primary domain, else null (callers fall back to the runtime target). */
function publicUrl(): string | null {
  const raw = env.OPENSHIP_PUBLIC_URL?.trim();
  if (raw) return raw.replace(/\/+$/, "");
  return cachedSelfAppUrl;
}

/**
 * The origin this API is actually reachable at (OPENSHIP_ADVERTISED_ORIGIN),
 * normalized. Desktop sets it to its dynamic loopback API origin. URL
 * construction ONLY — see the env field doc; never a security gate.
 */
function advertisedOrigin(): string | null {
  const raw = env.OPENSHIP_ADVERTISED_ORIGIN?.trim();
  return raw ? raw.replace(/\/+$/, "") : null;
}

/** Locate the self-app project id (cloud-linked or founding-admin org). */
async function locateSelfAppProjectId(): Promise<string | null> {
  const linked = await repos.settings.listCloudLinkedOrgIds().catch((diagnosticFailure) => { observeCaughtError(diagnosticFailure, "platform/engine/lib/public-url"); return [] as string[]; });
  for (const org of linked) {
    const p = await repos.project.findBySlugInOrg(org, SELF_APP_SLUG);
    if (p && p.appTemplateId === SELF_APP_SLUG) return p.id;
  }
  const admin = await repos.user.findFoundingAdmin();
  if (admin) {
    const p = await repos.project.findBySlugInOrg(`org_${admin.id}`, SELF_APP_SLUG);
    if (p && p.appTemplateId === SELF_APP_SLUG) return p.id;
  }
  return null;
}

/**
 * Recompute the cached self-app public URL from its verified primary domain.
 * Only accepts a domain on a project that has a real (adopt) active deployment.
 * Best-effort — keeps the prior value on error. Returns the resolved URL / null.
 */
export async function refreshSelfAppPublicUrl(): Promise<string | null> {
  const generation = cacheGeneration;
  try {
    const projectId = await locateSelfAppProjectId();
    if (!projectId) {
      if (generation === cacheGeneration) cachedSelfAppUrl = null;
      return null;
    }
    const project = await repos.project.findById(projectId);
    if (!project?.activeDeploymentId) {
      if (generation === cacheGeneration) cachedSelfAppUrl = null;
      return null;
    }
    const primary = await repos.domain.getPrimaryByProject(projectId);
    const resolved =
      primary &&
      primary.verified &&
      (primary.sslStatus === "active" || primary.sslStatus === "external")
        ? `https://${primary.hostname}`
        : null;
    if (generation === cacheGeneration) cachedSelfAppUrl = resolved;
    return resolved;
  } catch (diagnosticFailure) {
    observeCaughtError(diagnosticFailure, "platform/engine/lib/public-url");
    return cachedSelfAppUrl;
  }
}

/** Drop the cached self-app URL (call after a self-app domain change). */
export function invalidateSelfAppPublicUrl(): void {
  cacheGeneration += 1;
  cachedSelfAppUrl = null;
}

export interface InstanceReachability {
  /** A real public URL exists (env seed or a verified self-app domain) — NOT the
   *  loopback fallback. This is the authoritative "can teammates reach us" flag. */
  configured: boolean;
  /** The reachable public URL, or null when only loopback would answer. */
  url: string | null;
  source: "env" | "self-app" | null;
  /** The `openship` control-plane self-app project exists (deployable target
   *  for a domain). */
  selfAppInstalled: boolean;
  selfAppProjectId: string | null;
  /** The self-app has a primary domain (verified or still pending). */
  selfAppHasDomain: boolean;
  /** …and it's verified + SSL-ready, so it actually drives the public URL. */
  selfAppHasVerifiedDomain: boolean;
}

/**
 * The exported source-of-truth detector: "is this instance publicly reachable,
 * at what URL, and if not — what does the operator need to do." Surfaces the
 * null signal that `publicUrl()` computes internally (the exported URL builders
 * mask it with a localhost fallback). Consumed by the team-invite gate + its
 * inline guidance; the invite link itself still uses `resolveDashboardPublicUrl`,
 * which resolves to the same `url` when `configured`.
 */
export async function getInstanceReachability(): Promise<InstanceReachability> {
  const envUrl = env.OPENSHIP_PUBLIC_URL?.trim();
  if (envUrl) {
    return {
      configured: true,
      url: envUrl.replace(/\/+$/, ""),
      source: "env",
      selfAppInstalled: false,
      selfAppProjectId: null,
      selfAppHasDomain: false,
      selfAppHasVerifiedDomain: false,
    };
  }
  const selfAppProjectId = await locateSelfAppProjectId().catch((diagnosticFailure) => { observeCaughtError(diagnosticFailure, "platform/engine/lib/public-url"); return null; });
  if (!selfAppProjectId) {
    return {
      configured: false,
      url: null,
      source: null,
      selfAppInstalled: false,
      selfAppProjectId: null,
      selfAppHasDomain: false,
      selfAppHasVerifiedDomain: false,
    };
  }
  const primary = await repos.domain.getPrimaryByProject(selfAppProjectId).catch((diagnosticFailure) => { observeCaughtError(diagnosticFailure, "platform/engine/lib/public-url"); return null; });
  const hasVerifiedDomain =
    !!primary &&
    primary.verified &&
    (primary.sslStatus === "active" || primary.sslStatus === "external");
  await refreshSelfAppPublicUrl().catch((diagnosticFailure) => {
    observeCaughtError(diagnosticFailure, "platform/engine/lib/public-url");
  });
  const url = publicUrl();
  return {
    configured: !!url,
    url,
    source: url ? "self-app" : null,
    selfAppInstalled: true,
    selfAppProjectId,
    selfAppHasDomain: !!primary,
    selfAppHasVerifiedDomain: hasVerifiedDomain,
  };
}

/** Public origin serving the DASHBOARD (== the CLI `--public-url`), else the
 *  ACTUAL local dashboard origin (dynamic port on desktop, via
 *  OPENSHIP_LOCAL_DASHBOARD_URL), else the static runtime target. Used for the
 *  MCP loginPage/consentPage + invite/OIDC links — so on desktop these point at
 *  the real dashboard port, not the dead static one. */
export function resolveDashboardPublicUrl(): string {
  return publicUrl() ?? localDashboardUrl;
}

/**
 * Public base that maps to the API's own origin — the `runtimeTarget.api`
 * equivalent for a publicly-served box. Callers append `/api/...` paths.
 * Self-hosted + public URL → `<public-url>/api/proxy` (reachable via the
 * dashboard same-origin proxy). Otherwise → `runtimeTarget.api`.
 */
export function resolveApiPublicUrl(): string {
  const pub = publicUrl();
  return pub ? `${pub}${process.env.OPENSHIP_API_ONLY === "true" ? "" : SAME_ORIGIN_PROXY_PREFIX}` : runtimeTarget.api;
}

/**
 * `resolveApiPublicUrl` for a URL we hand back to the CALLER of this request
 * (rather than to a third party): the configured public base when there is one,
 * else the origin the caller actually reached us on. That fallback is what keeps
 * a desktop dynamic port or a LAN address from being advertised as
 * `localhost:4000`. Callers append `/api/...` paths.
 */
export function requestApiPublicUrl(req: Request): string {
  const pub = publicUrl();
  return pub ? resolveApiPublicUrl() : requestPublicOrigin(req);
}

/**
 * The shared repository webhook callback URL where providers POST
 * push/release deliveries. Public URL when configured, so a `--public-url` VPS
 * registers a reachable hook instead of a dead `localhost:4000` one.
 */
export function sharedWebhookUrl(provider = DEFAULT_GIT_PROVIDER): string {
  return `${resolveApiPublicUrl()}/api/webhooks/${encodeURIComponent(provider)}`;
}

/**
 * The delivery URL for a generic per-project incoming webhook — where the
 * external caller POSTs to fire the hook's action. Public URL when configured
 * so the URL shown to the user is actually reachable.
 */
export function incomingWebhookUrl(id: string): string {
  return `${resolveApiPublicUrl()}/api/webhooks/incoming/${id}`;
}

/**
 * The domain-strategy webhook callback URL: delivered directly to a project's
 * own verified domain via the `/_openship/hooks/` OpenResty location (proxied to
 * the loopback API). Used when a project sets an explicit `webhookDomain`.
 */
export function domainWebhookUrl(hostname: string, scheme: "http" | "https" = "https", provider = DEFAULT_GIT_PROVIDER): string {
  return `${scheme}://${hostname}/_openship/hooks/${encodeURIComponent(provider)}`;
}

/**
 * Better Auth `baseURL` — the origin every absolute auth/OAuth URL (issuer,
 * authorize, token, discovery metadata, email links) is built from.
 *
 * With a public URL configured, return it as a stable static base so remote
 * MCP/OAuth clients are handed reachable `https://<public-host>/api/auth/...`
 * URLs instead of `http://localhost:4000`. It must be static: Better Auth
 * materialises the OAuth authorization-server metadata at startup, with no
 * request in scope, so a `DynamicBaseURLConfig` resolves to an empty issuer
 * there; a discovery `issuer` also has to be stable across requests.
 *
 * Without a public URL, use OPENSHIP_ADVERTISED_ORIGIN when set (the desktop
 * app's real dynamic loopback API origin) so discovery/issuer/authorize/token
 * are reachable, else fall back to the static `runtimeTarget.api`.
 */
export function resolveAuthBaseUrl(): string {
  return publicUrl() ?? advertisedOrigin() ?? runtimeTarget.api;
}

/** First value of a (possibly comma-listed) forwarded header, trimmed, or null. */
function firstForwardedValue(raw: string | null): string | null {
  if (!raw) return null;
  const first = raw.split(",")[0]?.trim();
  return first || null;
}

/**
 * A well-formed forwarded host — hostname/IPv4 (optional `:port`) or
 * `[IPv6](:port)`. The `[a-zA-Z0-9.-]` charset rejects CRLF, spaces, schemes
 * (`//`), paths (`/`), and userinfo (`@`), so a spoofed `x-forwarded-host` can't
 * be reflected into an advertised URL (host-header injection / metadata poison).
 */
function isSafeForwardedHost(host: string): boolean {
  if (host.length > 260) return false;
  return (
    /^[a-zA-Z0-9.-]{1,253}(:\d{1,5})?$/.test(host) ||
    /^\[[0-9a-fA-F:]{2,45}\](:\d{1,5})?$/.test(host)
  );
}

/**
 * The public origin for a given inbound request — the configured public URL when
 * set, else the same-origin proxy's `x-forwarded-host`/`-proto` (validated).
 * Used to advertise reachable discovery URLs (MCP 401 `WWW-Authenticate`)
 * instead of the loopback origin the API actually binds to.
 */
export function requestPublicOrigin(req: Request): string {
  // Prefer the CONFIGURED origin so a properly-set-up instance never reflects an
  // attacker-controllable x-forwarded-host into advertised discovery URLs.
  const pub = publicUrl() ?? advertisedOrigin();
  if (pub) return pub;
  // Unconfigured (e.g. a bare loopback API behind a same-origin proxy with no
  // OPENSHIP_PUBLIC_URL): fall back to the proxy's forwarded host so discovery
  // stays reachable — but VALIDATE proto + host so a spoofed x-forwarded-host
  // can't poison the advertised origin. Never feeds an auth/zero-auth gate.
  const host = firstForwardedValue(req.headers.get("x-forwarded-host"));
  const proto = firstForwardedValue(req.headers.get("x-forwarded-proto"));
  if (host && (proto === "http" || proto === "https") && isSafeForwardedHost(host)) {
    return `${proto}://${host}`;
  }
  try {
    return new URL(req.url).origin;
  } catch {
    return runtimeTarget.api;
  }
}

/**
 * True when the URL points to a host that is NOT reachable from the
 * public internet — so GitHub's webhook delivery would fail.
 *
 * Used to decide between webhook strategies in resolveWebhookStrategy:
 *   - reachable → "repo" (per-repo webhook directly to this URL)
 *   - unreachable → "none" (caller falls back to polling or domain
 *     delivery via the project's webhookDomain)
 *
 * Conservative on parse failure (returns true). A typo'd URL is safer
 * to assume unreachable than to register a webhook GitHub will never
 * be able to deliver to.
 *
 * Covers the full set of non-routable host shapes:
 *   - DNS sentinels: localhost, *.local (mDNS)
 *   - IPv4 loopback: 127.0.0.0/8 (ALL of 127, not just .0.1)
 *   - IPv4 unspecified: 0.0.0.0
 *   - IPv4 RFC1918 private: 10/8, 172.16/12, 192.168/16
 *   - IPv4 link-local / APIPA: 169.254.0.0/16
 *   - IPv6 loopback: ::1 (with optional [::1] bracket form)
 *   - IPv6 link-local: fe80::/10
 *   - IPv6 ULA: fc00::/7 (fc/fd prefix)
 */
export function isLocalUrl(url: string): boolean {
  try {
    const { hostname } = new URL(url);
    if (!hostname) return true;

    // DNS sentinel cases. `.local` is mDNS (Bonjour) — reachable only on
    // the local link, never from the public internet.
    if (hostname === "localhost" || hostname === "0.0.0.0" || hostname.endsWith(".local")) {
      return true;
    }

    // IPv6 (URL parses bracketed form; strip the brackets for matching).
    // Same hostname can also arrive un-bracketed if the caller passed a
    // bare IP. fe80::/10 → fe80..febf (first byte top 10 bits); fc00::/7
    // → fc00..fdff (first byte top 7 bits, fc or fd).
    const v6 =
      hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
    if (v6 === "::1") return true;
    if (/^fe[89ab][0-9a-f]?:/i.test(v6)) return true; // link-local
    if (/^f[cd][0-9a-f]{2}:/i.test(v6)) return true; // ULA

    // IPv4: full 127/8 + 0/8-sentinel handled above + RFC1918 + link-local.
    // (Not collapsed into a single regex — readability beats brevity here,
    // and each /8|/12|/16 has a different intent that benefits from being
    // named in the source.)
    if (/^127\./.test(hostname)) return true; // loopback /8
    if (/^10\./.test(hostname)) return true; // RFC1918 /8
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(hostname)) return true; // RFC1918 /12
    if (/^192\.168\./.test(hostname)) return true; // RFC1918 /16
    if (/^169\.254\./.test(hostname)) return true; // link-local /16

    return false;
  } catch {
    return true;
  }
}
