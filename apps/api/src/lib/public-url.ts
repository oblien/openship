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

import { env, runtimeTarget, localDashboardUrl } from "../config/env";
import { repos, db, schema, eq } from "@repo/db";

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
  const linked = await repos.settings.listCloudLinkedOrgIds().catch(() => [] as string[]);
  for (const org of linked) {
    const p = await repos.project.findBySlugInOrg(org, SELF_APP_SLUG);
    if (p && p.appTemplateId === SELF_APP_SLUG) return p.id;
  }
  const [admin] = await db
    .select({ id: schema.user.id })
    .from(schema.user)
    .where(eq(schema.user.autoProvisioned, false))
    .orderBy(schema.user.createdAt)
    .limit(1);
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
  try {
    const projectId = await locateSelfAppProjectId();
    if (!projectId) {
      cachedSelfAppUrl = null;
      return null;
    }
    const project = await repos.project.findById(projectId);
    if (!project?.activeDeploymentId) {
      cachedSelfAppUrl = null;
      return null;
    }
    const primary = await repos.domain.getPrimaryByProject(projectId);
    cachedSelfAppUrl =
      primary && primary.verified && (primary.sslStatus === "active" || primary.sslStatus === "external")
        ? `https://${primary.hostname}`
        : null;
    return cachedSelfAppUrl;
  } catch {
    return cachedSelfAppUrl;
  }
}

/** Drop the cached self-app URL (call after a self-app domain change). */
export function invalidateSelfAppPublicUrl(): void {
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
  const selfAppProjectId = await locateSelfAppProjectId().catch(() => null);
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
  const primary = await repos.domain.getPrimaryByProject(selfAppProjectId).catch(() => null);
  const hasVerifiedDomain =
    !!primary && primary.verified && (primary.sslStatus === "active" || primary.sslStatus === "external");
  await refreshSelfAppPublicUrl().catch(() => {});
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
  return pub ? `${pub}${SAME_ORIGIN_PROXY_PREFIX}` : runtimeTarget.api;
}

/**
 * The shared/repo-strategy GitHub webhook callback URL — where GitHub POSTs
 * push/release deliveries. Public URL when configured, so a `--public-url` VPS
 * registers a reachable hook instead of a dead `localhost:4000` one.
 */
export function sharedWebhookUrl(): string {
  return `${resolveApiPublicUrl()}/api/webhooks/github`;
}

/**
 * The domain-strategy webhook callback URL: delivered directly to a project's
 * own verified domain via the `/_openship/hooks/` OpenResty location (proxied to
 * the loopback API). Used when a project sets an explicit `webhookDomain`.
 */
export function domainWebhookUrl(hostname: string, scheme: "http" | "https" = "https"): string {
  return `${scheme}://${hostname}/_openship/hooks/github`;
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
