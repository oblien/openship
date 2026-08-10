/**
 * Cloud SaaS controller - runs only in CLOUD_MODE.
 *
 * SaaS owns the Oblien master credentials, auth session management, and
 * handoff code generation. **All tenant-scoped operations forward via
 * the caller's namespace token** — Oblien enforces the namespace
 * boundary natively (no SaaS-side ledger / ownership check needed).
 *
 *   POST /api/cloud/token             - mint namespace-scoped Oblien token
 *   POST /api/cloud/analytics         - proxy Oblien analytics (namespace token)
 *   POST /api/cloud/edge-proxy        - sync Oblien edge proxy (namespace token)
 *   POST /api/cloud/pages             - proxy Oblien pages.create (namespace token)
 *   POST /api/cloud/preflight         - cloud deployment preflight check
 *   GET  /api/cloud/desktop-handoff   - OAuth → one-time code → redirect to desktop
 *   GET  /api/cloud/connect-handoff   - validates params, 302s to dashboard consent page
 *   POST /api/cloud/connect-authorize - dashboard consent page mints code with session
 *   POST /api/cloud/exchange-code     - exchange code for user + session (no auth)
 */

import type { Context } from "hono";
import { getRequestContext } from "../../lib/request-context";
import { auth } from "../../lib/auth";
import { issueNamespaceToken } from "../../lib/openship-cloud";
import {
  exchangeHandoffCode,
  validateDesktopRedirect,
  validateConnectRedirect,
  buildAuthHandoff,
  generateHandoffCode,
  findHandoffCodeByState,
  mintSession,
} from "../../lib/cloud-auth-proxy";
import { runCloudPreflight } from "../../lib/cloud-preflight";
import { cloudRuntimeTarget } from "../../config/env";
import * as githubAuth from "../github/github.auth";
import {
  proxyCloudAnalytics,
  CloudAnalyticsForbiddenError,
  type CloudAnalyticsOperation,
} from "./cloud-analytics.service";
import { revokeCloudSession } from "./cloud-session.service";
import {
  syncCloudEdgeProxy,
  deleteCloudEdgeProxy,
  requestCloudEdgeVerification,
  checkCloudEdgeVerification,
} from "./cloud-edge-proxy.service";
import {
  createCloudPage,
  dispatchCloudPageAction,
} from "./cloud-pages.service";
import { sendCloudInvitation } from "./cloud-invitations.service";
import {
  ingestSubgraph,
  exportSubgraph,
  teardownProjectSubgraph,
  projectExistsInOrg,
  IngestValidationError,
  IngestTargetNotEmptyError,
  TeardownProjectNotFoundError,
} from "./cloud-ingest.service";
import {
  DUMP_FORMAT_VERSION,
  PkCollisionError,
  type DatabaseDump,
  type SubgraphScope,
} from "@repo/db";
import {
  startGithubLinkFromBridgeToken,
  buildOrgScopedInstallUrl,
  attributeGithubInstall,
  listOrgInstallations,
  mintOrgInstallationToken,
  oauthBridgeStore,
  OAUTH_BRIDGE_TTL_MS,
} from "./cloud-github.service";

/** Coerce a thrown Oblien SDK error into an HTTP response shape. */
function oblienErrorResponse(c: Context, err: unknown, fallback: string) {
  const message = err instanceof Error ? err.message : fallback;
  const status =
    typeof err === "object" && err !== null && "status" in err && typeof (err as { status?: unknown }).status === "number"
      ? (err as { status: number }).status
      : 500;
  const code =
    typeof err === "object" && err !== null && "code" in err
      ? (err as { code?: unknown }).code
      : undefined;
  // Server faults must be diagnosable — the message alone (returned in the body)
  // is not enough for a DB error (we need the pg code + stack). 4xx are expected
  // control-flow (validation, conflicts) and stay quiet.
  if (status >= 500) {
    console.error(`[cloud] ${fallback}:`, err);
  }
  c.status(status as 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500);
  return c.json({ error: message, code });
}

// ─── Cloud analytics proxy ──────────────────────────────────────────────────

/**
 * POST /api/cloud/analytics  { operation, domain, params }
 *
 * Local/desktop instances call this to read Oblien analytics for a
 * hostname they own on Openship Cloud. Forwarded via the caller's
 * namespace token — Oblien returns data only for hostnames in the
 * caller's namespace, so cross-tenant access is structurally
 * impossible. No SaaS-side ownership check needed.
 */
export async function analyticsProxy(c: Context) {
  const ctx = getRequestContext(c);
  const { operation, domain, params } = await c.req.json<{
    operation: CloudAnalyticsOperation;
    domain: string;
    params?: Record<string, unknown>;
  }>();
  if (!operation || !domain) {
    return c.json({ error: "operation and domain are required" }, 400);
  }
  if (operation !== "timeseries" && operation !== "requests" && operation !== "streamToken") {
    return c.json({ error: "Unknown operation" }, 400);
  }
  try {
    const result = await proxyCloudAnalytics(ctx.organizationId, { operation, domain, params });
    return c.json({ data: result });
  } catch (err) {
    if (err instanceof CloudAnalyticsForbiddenError) {
      return c.json({ error: err.message }, 403);
    }
    return oblienErrorResponse(c, err, "Analytics request failed");
  }
}

// ─── Namespace token minting ─────────────────────────────────────────────────

export async function getToken(c: Context) {
  const ctx = getRequestContext(c);
  const result = await issueNamespaceToken(ctx.organizationId);
  return c.json({ data: result });
}

export async function preflight(c: Context) {
  const ctx = getRequestContext(c);
  const body = await c.req.json<{ slug?: string; customDomain?: string }>();
  const result = await runCloudPreflight(ctx.organizationId, {
    slug: body.slug,
    customDomain: body.customDomain,
  });
  return c.json({ data: result });
}

/**
 * POST /api/cloud/disconnect  (bearer-authed)
 *
 * Revoke the current cloud_session_token by deleting its row in the
 * session table. Called from the local `disconnectCloud()` helper
 * BEFORE clearing the token from local DB — so the SaaS-side session
 * stops being usable immediately, instead of lingering for its full
 * 30-day TTL.
 *
 * Defense-in-depth against the threat model of "local DB exfiltrated
 * before disconnect was clicked": even if the attacker has the token
 * bytes, this endpoint kills the row, so the bytes become inert the
 * moment the user clicks Disconnect.
 *
 * Idempotent: if the row is already gone, returns success.
 */
export async function disconnect(c: Context) {
  const session = c.get("session") as { id?: string; token?: string } | undefined;
  const user = c.get("user") as { id?: string } | undefined;
  const result = await revokeCloudSession({
    sessionId: session?.id,
    userId: user?.id,
    clientIp: c.var.clientIp,
    userAgent: c.req.header("user-agent") ?? null,
  });
  if (!result.ok) {
    return c.json({ error: result.error }, 500);
  }
  return c.json({ ok: true });
}

export async function account(c: Context) {
  const user = c.get("user") as
    | { name?: string | null; email?: string | null; image?: string | null }
    | undefined;

  if (!user?.email) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  return c.json({
    user: {
      name: user.name ?? user.email,
      email: user.email,
      image: user.image ?? null,
    },
  });
}

// ─── Desktop OAuth handoff ───────────────────────────────────────────────────

/**
 * GET /api/cloud/desktop-handoff?redirect=<url>&state=<state>&code_challenge=<challenge>
 *
 * Security:
 *   - redirect MUST be localhost (desktop callback) - no open redirect
 *   - state is passed through unchanged for CSRF protection
 *   - code_challenge (PKCE S256) is bound to the one-time code
 */
export async function desktopHandoff(c: Context) {
  const codeChallenge = c.req.query("code_challenge");
  if (!codeChallenge || !/^[A-Za-z0-9_-]{40,128}$/.test(codeChallenge)) {
    return c.json({ error: "code_challenge query parameter is required", code: "MISSING_CODE_CHALLENGE" }, 400);
  }
  const validation = validateDesktopRedirect(c.req.query("redirect"));
  if (!validation.ok) return c.json({ error: validation.error }, validation.status);
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  const result = await buildAuthHandoff({
    session,
    redirect: validation.url,
    state: c.req.query("state"),
    codeChallenge,
    dashboardOrigin: cloudRuntimeTarget.dashboard,
    loginFlow: "desktop-cloud",
  });
  return c.redirect(result.url);
}

// ─── Self-hosted connect handoff ─────────────────────────────────────────────

/**
 * GET /api/cloud/connect-handoff?redirect=<url>&state=<state>&code_challenge=<challenge>
 *
 * Browser entry point for the self-hosted "Connect to Cloud" flow. We
 * intentionally do NOT mint a handoff code here — that would let any
 * authenticated browser silently issue connect codes for arbitrary
 * (validated) redirects. Instead we 302 the browser to a dashboard-
 * hosted consent page, which gates the code mint behind an explicit
 * "Authorize" click.
 *
 * Validates the params once on entry so the dashboard page can't be
 * loaded with a malformed redirect. Validation errors are surfaced as
 * 400 JSON exactly like before.
 *
 * Security:
 *   - redirect MUST be HTTPS (no downgrade to HTTP), except localhost
 *   - state + code_challenge are propagated to the dashboard page,
 *     which re-validates and forwards them to /connect-authorize
 *   - Code mint happens on POST /connect-authorize, not here
 */
export async function connectHandoff(c: Context) {
  const isDevice = c.req.query("mode") === "device";
  const codeChallenge = c.req.query("code_challenge");
  if (!codeChallenge || !/^[A-Za-z0-9_-]{40,128}$/.test(codeChallenge)) {
    return c.json({ error: "code_challenge query parameter is required", code: "MISSING_CODE_CHALLENGE" }, 400);
  }
  const state = c.req.query("state");
  if (!state || typeof state !== "string" || state.length === 0 || state.length > 256) {
    return c.json({ error: "state query parameter is required", code: "MISSING_STATE" }, 400);
  }

  // Redirect to the dashboard consent page. The dashboard handles
  // authentication-checking (bouncing to /login with returnTo) and
  // renders the consent UI; on Authorize click it POSTs back to
  // /api/cloud/connect-authorize below, which is where the code mint
  // actually happens.
  const consentUrl = new URL("/cloud-authorize", cloudRuntimeTarget.dashboard);
  consentUrl.searchParams.set("state", state);
  consentUrl.searchParams.set("code_challenge", codeChallenge);
  if (isDevice) {
    // Device/poll flow (headless CLI): the code is delivered via connect-poll,
    // not a browser redirect, so `redirect` is neither required nor forwarded —
    // the consent page confirms in-place.
    consentUrl.searchParams.set("mode", "device");
  } else {
    const validation = validateConnectRedirect(c.req.query("redirect"));
    if (!validation.ok) return c.json({ error: validation.error }, validation.status);
    consentUrl.searchParams.set("redirect", validation.url.toString());
  }
  return c.redirect(consentUrl.toString());
}

/**
 * POST /api/cloud/connect-authorize
 *
 * Called by the dashboard consent page after the user clicks
 * "Authorize". Requires a Better-Auth session cookie (the page itself
 * is dashboard-served, so the cookie is in scope). Mints a one-time
 * handoff code bound to the supplied PKCE challenge and returns the
 * final callback URL the page should navigate to.
 *
 * Body shape: { redirect, state, codeChallenge }
 *
 * Returns:
 *   200 { callbackUrl }        — on success
 *   400 { error, code }        — on validation failure
 *   401 { error, code }        — on missing/expired session
 *   500 { error, code }        — on unexpected mint failure
 */
export async function connectAuthorize(c: Context) {
  let body: { redirect?: string; state?: string; codeChallenge?: string; mode?: string };
  try {
    body = await c.req.json<{ redirect?: string; state?: string; codeChallenge?: string; mode?: string }>();
  } catch {
    return c.json({ error: "Invalid JSON body", code: "INVALID_BODY" }, 400);
  }

  const isDevice = body.mode === "device";
  const codeChallenge = body.codeChallenge;
  if (!codeChallenge || !/^[A-Za-z0-9_-]{40,128}$/.test(codeChallenge)) {
    return c.json(
      { error: "codeChallenge is required", code: "MISSING_CODE_CHALLENGE" },
      400,
    );
  }
  // `redirect` is the delivery channel ONLY for the browser flow, where it MUST
  // be validated (open-redirect/SSRF). The device/poll flow delivers the code via
  // connect-poll — PKCE-locked + state-keyed — so it needs no redirect and there's
  // no redirect target to guard.
  let redirectUrl: string | undefined;
  if (!isDevice) {
    const validation = validateConnectRedirect(body.redirect);
    if (!validation.ok) {
      return c.json({ error: validation.error, code: "INVALID_REDIRECT" }, validation.status);
    }
    redirectUrl = validation.url.toString();
  }
  const state = body.state;
  if (!state || typeof state !== "string" || state.length === 0 || state.length > 256) {
    return c.json({ error: "state is required", code: "MISSING_STATE" }, 400);
  }

  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) {
    return c.json({ error: "Authentication required", code: "UNAUTHENTICATED" }, 401);
  }

  try {
    // CRITICAL: do NOT hand the local instance the user's current
    // browser cookie session token. The local instance later calls
    // POST /api/cloud/disconnect which deletes the session row by
    // id — handing over the cookie session would mean a "disconnect
    // local from cloud" click logs the user out of app.openship.io.
    //
    // Instead, mint a dedicated session row for the linked-instance
    // bearer flow. The cookie session stays untouched; disconnect
    // kills only the row we just created.
    // activeOrganizationId is NOT NULL in the schema — every SaaS user
    // gets a personal `org_<userId>` provisioned at signup, so fall
    // back to that when the cookie session somehow has it null
    // (Better Auth's plugin types it loosely).
    const linked = await mintSession({
      purpose: "linked-instance",
      userId: session.user.id,
      activeOrganizationId:
        session.session.activeOrganizationId ?? `org_${session.user.id}`,
      ipAddress: c.get("clientIp") ?? null,
      userAgent: c.req.header("user-agent") ?? null,
    });

    const code = await generateHandoffCode(
      {
        id: session.user.id,
        name: session.user.name,
        email: session.user.email,
        emailVerified: session.user.emailVerified,
        image: session.user.image ?? null,
      },
      linked.token,
      codeChallenge,
      // Record `state` so a headless CLI (device/poll flow) can retrieve this
      // code via connect-poll instead of catching the browser redirect.
      state,
    );
    // Device/poll: nothing to navigate to — the CLI's poll picks up the code.
    if (isDevice) return c.json({ authorized: true });
    const callbackUrl = new URL(redirectUrl!);
    callbackUrl.searchParams.set("code", code);
    callbackUrl.searchParams.set("state", state);
    return c.json({ callbackUrl: callbackUrl.toString() });
  } catch (err) {
    console.error("[connect-authorize] mint failed:", err);
    return c.json(
      { error: "Failed to mint handoff code", code: "MINT_FAILED" },
      500,
    );
  }
}

// ─── Code exchange (no auth - code is the credential) ────────────────────────

export async function exchangeCode(c: Context) {
  const body = await c.req.json<{ code: string; code_verifier?: string }>();
  if (!body.code) {
    return c.json({ error: "Code required" }, 400);
  }

  const result = await exchangeHandoffCode(body.code, body.code_verifier);
  if (!result) {
    return c.json({ error: "Invalid or expired code" }, 401);
  }

  return c.json({ data: result });
}

// ─── Device/poll flow (headless CLI — no browser redirect back to the box) ───

/**
 * GET /api/cloud/connect-poll?state=<state>
 *
 * The server-friendly half of cloud-connect: a CLI running on a remote box
 * (over SSH) can't receive the browser redirect to its own loopback listener,
 * so instead it POLLS here with the unguessable `state` it generated. Returns
 * the one-time handoff code once the user has clicked Authorize in their
 * browser, else `{ status: "pending" }`.
 *
 * No session (the CLI has no SaaS cookie). Security rests on: `state` is a
 * 128+-bit capability never shown to the user; the returned `code` is still
 * PKCE-locked (worthless without the verifier the CLI holds) and one-time at
 * exchange; the endpoint is rate-limited per-IP.
 */
export async function connectPoll(c: Context) {
  const state = c.req.query("state");
  if (!state || state.length < 16 || state.length > 256) {
    return c.json({ error: "state is required", code: "MISSING_STATE" }, 400);
  }
  const code = await findHandoffCodeByState(state);
  return code ? c.json({ status: "ready", code }) : c.json({ status: "pending" });
}

// ─── Managed edge proxy sync ─────────────────────────────────────────────────

/**
 * POST /api/cloud/edge-proxy  { slug, target }
 *
 * Self-hosted/desktop instances send the project slug + target IP.
 * SaaS forwards to Oblien with the caller's namespace token. Oblien
 * enforces slug uniqueness across the shared zone (returns 409 if
 * another namespace owns it) and binds the proxy to the caller's
 * namespace — no SaaS-side ledger needed.
 *
 * Idempotent: if the slug is already owned by the caller, Oblien
 * returns the existing proxy. If owned by another tenant, Oblien
 * returns 409 and we forward that status.
 */
export async function syncEdgeProxy(c: Context) {
  const ctx = getRequestContext(c);
  const body = await c.req.json<{ slug?: string; target?: string }>();
  if (!body.slug || !body.target) {
    return c.json({ error: "slug and target are required" }, 400);
  }
  try {
    const result = await syncCloudEdgeProxy(ctx.organizationId, { slug: body.slug, target: body.target });
    if (!result.ok) return c.json({ error: result.error }, result.status);
    return c.json({ ok: true, hostname: result.hostname });
  } catch (err) {
    return oblienErrorResponse(c, err, "Failed to sync edge proxy");
  }
}

/**
 * POST /api/cloud/edge-proxy/delete  { slug }
 *
 * Tear down the caller's managed edge proxy for a freed slug (a dropped free
 * *.opsh.io domain). Namespace-scoped, so a caller can only remove its own
 * proxy. Idempotent — an unknown slug returns `removed:false`, not an error.
 */
export async function deleteEdgeProxy(c: Context) {
  const ctx = getRequestContext(c);
  const body = await c.req.json<{ slug?: string }>();
  if (!body.slug) {
    return c.json({ error: "slug is required" }, 400);
  }
  try {
    const result = await deleteCloudEdgeProxy(ctx.organizationId, { slug: body.slug });
    if (!result.ok) return c.json({ error: result.error }, result.status);
    return c.json({ ok: true, removed: result.removed });
  } catch (err) {
    return oblienErrorResponse(c, err, "Failed to delete edge proxy");
  }
}

/**
 * POST /api/cloud/edge-proxy/verify  { target }
 *
 * Start proving that the caller controls a routing target. Returns a one-time token
 * and the path to serve it at; the box installs it on its edge and then calls
 * /verify-check. Namespace-scoped, so the record belongs to the caller's org.
 */
export async function requestEdgeVerification(c: Context) {
  const ctx = getRequestContext(c);
  const body = await c.req.json<{ target?: string }>();
  if (!body.target) {
    return c.json({ error: "target is required" }, 400);
  }
  try {
    const result = await requestCloudEdgeVerification(ctx.organizationId, { target: body.target });
    if (!result.ok) return c.json({ error: result.error }, result.status);
    return c.json({ ok: true, verification: result.verification });
  } catch (err) {
    return oblienErrorResponse(c, err, "Failed to request edge target verification");
  }
}

/**
 * POST /api/cloud/edge-proxy/verify-check  { verificationId }
 *
 * Run the probe for a challenge this org requested. The upstream fetches the token
 * from the target over an SSRF-safe pinned connection; on success the target becomes
 * routable and the route is pinned to the validated IP.
 */
export async function checkEdgeVerification(c: Context) {
  const ctx = getRequestContext(c);
  const body = await c.req.json<{ verificationId?: number }>();
  if (typeof body.verificationId !== "number") {
    return c.json({ error: "verificationId is required" }, 400);
  }
  try {
    const result = await checkCloudEdgeVerification(ctx.organizationId, {
      verificationId: body.verificationId,
    });
    if (!result.ok) return c.json({ error: result.error }, result.status);
    return c.json({ ok: true, verification: result.verification });
  } catch (err) {
    return oblienErrorResponse(c, err, "Failed to check edge target verification");
  }
}

// ─── Pages proxy ────────────────────────────────────────────────────────────

/**
 * POST /api/cloud/pages  { workspace_id, path, name, slug, domain? }
 *
 * Forwards to Oblien with the caller's namespace token. Oblien
 * enforces:
 *   - `workspace_id` must belong to the caller's namespace (or 404)
 *   - `slug` must be free on the shared zone (or 409 SLUG_TAKEN)
 *
 * Returns the raw Oblien SDK shape so the caller's CloudRuntime code
 * path stays unchanged.
 */
export async function pagesProxy(c: Context) {
  const ctx = getRequestContext(c);
  const body = await c.req.json<{
    workspace_id?: string;
    path?: string;
    name?: string;
    slug?: string;
    domain?: string;
  }>();
  if (!body.workspace_id || !body.path || !body.name || !body.slug) {
    return c.json({ error: "workspace_id, path, name and slug are required" }, 400);
  }
  try {
    const result = await createCloudPage(ctx, {
      workspace_id: body.workspace_id,
      path: body.path,
      name: body.name,
      slug: body.slug,
      domain: body.domain,
    });
    return c.json(result);
  } catch (err) {
    return oblienErrorResponse(c, err, "Failed to create page");
  }
}

/**
 * POST /api/cloud/pages/disable  { slug }
 *
 * Forwards via the caller's namespace token. Oblien rejects slugs
 * that don't belong to the namespace with 403/404, surfaced here as
 * 403 by isCrossTenantError. No SaaS-side ownership check needed —
 * the namespace IS the tenant boundary, sourced from the session.
 */
export async function pagesDisable(c: Context) {
  const ctx = getRequestContext(c);
  const body = await c.req.json<{ slug?: string }>();
  if (!body.slug) return c.json({ error: "slug is required" }, 400);
  try {
    const result = await dispatchCloudPageAction(ctx, body.slug, "disable");
    if (!result.ok) return c.json({ error: result.error }, result.status);
    return c.json({ ok: true });
  } catch (err) {
    return oblienErrorResponse(c, err, "Failed to disable page");
  }
}

/**
 * POST /api/cloud/pages/enable  { slug }
 *
 * Forwards via the caller's namespace token. Oblien rejects slugs
 * that don't belong to the namespace with 403/404, surfaced here as
 * 403 by isCrossTenantError. No SaaS-side ownership check needed —
 * the namespace IS the tenant boundary, sourced from the session.
 */
export async function pagesEnable(c: Context) {
  const ctx = getRequestContext(c);
  const body = await c.req.json<{ slug?: string }>();
  if (!body.slug) return c.json({ error: "slug is required" }, 400);
  try {
    const result = await dispatchCloudPageAction(ctx, body.slug, "enable");
    if (!result.ok) return c.json({ error: result.error }, result.status);
    return c.json({ ok: true });
  } catch (err) {
    return oblienErrorResponse(c, err, "Failed to enable page");
  }
}

/**
 * POST /api/cloud/pages/delete  { slug }
 *
 * Forwards via the caller's namespace token. Oblien rejects slugs
 * that don't belong to the namespace with 403/404, surfaced here as
 * 403 by isCrossTenantError. No SaaS-side ownership check needed —
 * the namespace IS the tenant boundary, sourced from the session.
 */
export async function pagesDelete(c: Context) {
  const ctx = getRequestContext(c);
  const body = await c.req.json<{ slug?: string }>();
  if (!body.slug) return c.json({ error: "slug is required" }, 400);
  try {
    const result = await dispatchCloudPageAction(ctx, body.slug, "delete");
    if (!result.ok) return c.json({ error: result.error }, result.status);
    return c.json({ ok: true });
  } catch (err) {
    return oblienErrorResponse(c, err, "Failed to delete page");
  }
}

// ─── Invitation relay ───────────────────────────────────────────────────────

/**
 * POST /api/cloud/send-invitation  { to, subject, html, text }
 *
 * Local self-hosted instances POST here when their operator has set
 * `invitationMailSource = "cloud"` in instance_settings. The SaaS sends
 * the email from its own mail infrastructure on the local instance's
 * behalf — useful for self-hosted deployments that don't want to run
 * their own SMTP server.
 *
 * Auth: cloudSessionAuth (Bearer cloud session) resolves the org owner;
 * the active organization is read from middleware as for every other
 * org-scoped endpoint.
 *
 * Rate-limit: capped at 20/hour per org inside the service so a
 * compromised local can't spam invitations through us.
 */
export async function sendInvitation(c: Context) {
  const ctx = getRequestContext(c);
  const body = await c.req.json<{
    to?: string;
    subject?: string;
    html?: string;
    text?: string;
  }>();
  if (!body.to || !body.subject || !body.html || !body.text) {
    return c.json({ error: "to, subject, html and text are required" }, 400);
  }
  try {
    const result = await sendCloudInvitation(ctx.organizationId, {
      to: body.to,
      subject: body.subject,
      html: body.html,
      text: body.text,
    });
    if (!result.ok) return c.json({ error: result.error }, result.status);
    return c.json({ ok: true, messageId: result.messageId });
  } catch (err) {
    return oblienErrorResponse(c, err, "Failed to send invitation");
  }
}

// ─── Subgraph ingest/export (unified primitives) ─────────────────────────────

/**
 * POST /api/cloud/ingest-subgraph  { dump, allowNonEmptyTarget? }
 *
 * Generalised forward primitive. Accepts an organization-scope or
 * project-scope dump. The instance-scope rejection is enforced inside
 * ingestSubgraph.
 */
export async function ingestSubgraphHandler(c: Context) {
  const ctx = getRequestContext(c);
  const body = await c.req.json<{
    dump?: DatabaseDump;
    allowNonEmptyTarget?: boolean;
  }>();
  if (!body.dump) {
    return c.json({ error: "dump is required" }, 400);
  }
  if (body.dump.formatVersion !== DUMP_FORMAT_VERSION) {
    return c.json(
      {
        error: `Dump format ${body.dump.formatVersion} incompatible with this SaaS (expected ${DUMP_FORMAT_VERSION}). Update your local instance and re-dump.`,
        code: "INGEST_FORMAT_MISMATCH",
      },
      412,
    );
  }
  try {
    const result = await ingestSubgraph({
      organizationId: ctx.organizationId,
      dump: body.dump,
      allowNonEmptyTarget: body.allowNonEmptyTarget,
    });
    return c.json({ ok: true, ...result });
  } catch (err) {
    if (err instanceof IngestTargetNotEmptyError) {
      return c.json(
        { error: err.message, code: err.code, projectCount: err.projectCount },
        409,
      );
    }
    if (err instanceof IngestValidationError) {
      return c.json({ error: err.message, code: err.code }, 400);
    }
    if (err instanceof PkCollisionError) {
      // A pkey collision = the SAME project id already exists → a genuine
      // leftover transfer of THIS project (PK_COLLISION). Any OTHER unique
      // constraint (slug / name / hostname) = a DIFFERENT project already owns
      // that name → SLUG_TAKEN, so the operator gets "rename and retry" instead
      // of the misleading "clean up the leftover copy". Unknown constraint falls
      // back to PK_COLLISION (unchanged behavior).
      const constraint = (err.cause as { constraint?: unknown } | null)?.constraint;
      const nameTaken = typeof constraint === "string" && !constraint.endsWith("_pkey");
      if (nameTaken) {
        return c.json(
          {
            error: "A project with this name already exists on Openship Cloud. Rename this project and retry.",
            code: "SLUG_TAKEN",
            table: err.table,
          },
          409,
        );
      }
      // Duplicate-PK on the subgraph restore — the operator is re-submitting an
      // already-transferred project. Typed 409 so the dashboard can offer a
      // clean "already transferred" remediation instead of an opaque 500.
      return c.json(
        { error: err.message, code: err.code, table: err.table },
        409,
      );
    }
    return oblienErrorResponse(c, err, "Subgraph ingest failed");
  }
}

/**
 * POST /api/cloud/teardown-project  { projectId }
 *
 * Delete a project's rows on the SaaS for the caller's org. Used by the
 * bring-home flow (drop the cloud copy after demote) and by force-reconcile
 * (a local promote found a leftover cloud copy and cleans it before retrying).
 * Ownership-scoped inside the service — refuses projects outside the org.
 */
export async function teardownProjectHandler(c: Context) {
  const ctx = getRequestContext(c);
  const body = await c.req
    .json<{ projectId?: string }>()
    .catch(() => ({} as { projectId?: string }));
  if (!body.projectId) {
    return c.json({ error: "projectId is required" }, 400);
  }
  try {
    await teardownProjectSubgraph({
      organizationId: ctx.organizationId,
      projectId: body.projectId,
    });
    return c.json({ ok: true });
  } catch (err) {
    if (err instanceof TeardownProjectNotFoundError) {
      return c.json({ error: err.message, code: err.code }, 404);
    }
    return oblienErrorResponse(c, err, "Project teardown failed");
  }
}

/**
 * POST /api/cloud/export-subgraph  { scope }
 *
 * Caller picks the scope shape (organization == team-mode switch-back,
 * project == project transfer to-self-hosted). Instance scope is refused.
 */
export async function exportSubgraphHandler(c: Context) {
  const ctx = getRequestContext(c);
  const body = await c.req
    .json<{ scope?: SubgraphScope }>()
    .catch(() => ({} as { scope?: SubgraphScope }));
  const scope: SubgraphScope = body.scope ?? { kind: "organization", organizationId: ctx.organizationId };

  if (scope.kind === "instance") {
    return c.json(
      { error: "Instance-scope export is not permitted on the SaaS.", code: "EXPORT_SCOPE_DENIED" },
      403,
    );
  }
  if (scope.kind === "organization" && scope.organizationId !== ctx.organizationId) {
    return c.json(
      { error: "Cannot export another organization.", code: "EXPORT_SCOPE_DENIED" },
      403,
    );
  }
  if (scope.kind === "project") {
    if (!(await projectExistsInOrg(scope.projectId, ctx.organizationId))) {
      return c.json(
        { error: "Project not found in caller's organization.", code: "EXPORT_SCOPE_DENIED" },
        404,
      );
    }
  }

  try {
    const dump = await exportSubgraph(scope);
    return c.json({ ok: true, dump });
  } catch (err) {
    return oblienErrorResponse(c, err, "Subgraph export failed");
  }
}

// ─── GitHub App proxy (cloud-mode only — holds the App private key) ─────────
//
// These endpoints are what self-hosted instances call via cloud-client.ts.
// All App credentials (GITHUB_APP_ID, GITHUB_PRIVATE_KEY) live here in cloud
// mode and never leave — local just hands off (userId, request) and receives
// resolved data back. Local never sees the JWT, never signs anything.
//
// `cloudSessionAuth` middleware (applied on the routes file) resolves the
// caller.s Better-Auth user from their session token; `getRequestContext(c).userId` returns
// that user's id. Each cloud user's installations / OAuth identity are
// already managed by the existing local github code paths, so we just reuse
// them — this controller is a thin policy/translation layer.

// ─── OAuth bridge (browser-session handoff for linkSocialAccount) ───────────
//
// SaaS-only OAuth flow. Self-hosted instances never hold GitHub OAuth
// credentials — they redirect the user's browser to api.openship.io
// where the real OAuth round-trip happens against the SaaS's Better
// Auth instance. The browser starts with no SaaS session cookie (it
// only has a local session), so we need a 2-hop handoff:
//
//   1. Local POSTs /oauth-handoff with its cloud_session_token Bearer.
//      SaaS resolves the bearer to a Better-Auth session, mints a
//      one-time bridge token storing (userId, sessionToken), returns
//      a URL pointing at /oauth-bridge?token=<bridge>.
//
//   2. Browser opens /oauth-bridge?token=<>. SaaS consumes the bridge
//      (single-use), constructs Better-Auth session headers from the
//      stashed sessionToken, calls auth.api.linkSocialAccount which
//      returns the GitHub OAuth redirect URL + state cookies. SaaS
//      forwards the redirect AND sets the user's Better-Auth session
//      cookie on the browser so when GitHub redirects back to Better
//      Auth's callback URL, it resolves to the right user and creates
//      the `account` row with providerId='github'.
//
// After this, the SaaS has authoritative knowledge of the user's
// GitHub identity. findUserByGitHubId in the install webhook will
// succeed, getUserToken will return the user's OAuth token, and
// getUserInstallations will work end-to-end.

// ─── GitHub Connect flow: architecture overview ─────────────────────────────
//
// SaaS-only OAuth + install flow. Local self-hosted instances NEVER hold
// GitHub OAuth credentials, GitHub App private keys, or the gitInstallation
// table for the App. Everything flows through api.openship.io.
//
// Three independent identity envelopes chain together:
//
//   ┌─ Local DB ────────────────┐   ┌─ SaaS process memory ─────┐   ┌─ Browser ─────────────┐
//   │ user_settings.cloud_      │   │ oauthBridges Map          │   │ Better Auth oauth_     │
//   │ session_token (AES at     │ → │ {userId, sessionToken}    │ → │ state cookie           │
//   │ rest with BETTER_AUTH_    │   │ 16 random bytes, 5min TTL │   │ AES-encrypted {link:  │
//   │ SECRET-derived key)       │   │ single-use                │   │ {email, userId}}      │
//   └───────────────────────────┘   └───────────────────────────┘   └───────────────────────┘
//          Step 1: Local→SaaS              Step 2: SaaS→Browser           Step 3: Browser→GitHub→SaaS
//          Authorization: Bearer            ?token=<bridge> in URL         redirect chain
//
// Security invariants:
//   - The popup browser NEVER receives the SaaS Better Auth session
//     cookie. Only the oauth_state cookies are forwarded (see the
//     allowedCookieNames filter in filterForwardableStateCookies). The
//     state cookie itself carries the {link: {email, userId}} binding all
//     the way to GitHub's callback, and Better Auth's callback handler
//     (callback.mjs:102-128) reads userId from the decrypted state — it
//     never consults c.context.session for link flows.
//   - The bridge token in /oauth-bridge?token=<> is single-use AND
//     time-bound. Leaking it via access logs / browser history is bounded
//     by both: the consumer races first (consumeOauthBridge deletes
//     before returning), and the 5-min TTL.
//   - The link binding (userId) lives ONLY inside the encrypted state
//     cookie. The bridge token itself is opaque randomness — leaking
//     it from a URL reveals no PII or userId.
//
// Do NOT add a session-cookie set on the popup browser response from
// /oauth-bridge — that would silently log the popup into the SaaS
// dashboard, conflating identities across the local and SaaS tiers.

/**
 * POST /api/cloud/github/oauth-handoff   (bearer-authed via cloudSessionAuth)
 *
 * Returns a one-time URL the browser opens to start GitHub OAuth on the
 * SaaS. The URL points at the public /oauth-bridge endpoint with a
 * single-use bridge token. The bridge then calls Better Auth's
 * linkSocialAccount via the bearer plugin (Authorization: Bearer
 * sessionToken) to obtain the GitHub OAuth redirect URL + state
 * cookies, forwards both to the browser, and the browser proceeds to
 * GitHub.
 */
export async function githubOauthHandoff(c: Context) {
  // cloudSessionAuth middleware (mounted on /github/*) already resolved
  // the Bearer token into a session row + user. We read them straight
  // from the context instead of calling auth.api.getSession (which only
  // reads cookies, not the Bearer header we authenticate cloud-client
  // requests with).
  const user = c.get("user") as { id: string } | undefined;
  const session = c.get("session") as { token: string } | undefined;
  if (!user || !session) {
    return c.json({ error: "No active session" }, 401);
  }
  const token = await oauthBridgeStore.issue(
    { userId: user.id, sessionToken: session.token },
    { ttlMs: OAUTH_BRIDGE_TTL_MS },
  );
  return c.json({
    data: {
      url: `${cloudRuntimeTarget.api}/api/cloud/github/oauth-bridge?token=${encodeURIComponent(token)}`,
    },
  });
}

/**
 * GET /api/cloud/github/oauth-bridge?token=<>   (PUBLIC)
 *
 * Browser opens this from a popup. We consume the bridge token, set the
 * user's Better-Auth session cookie on the browser, call
 * auth.api.linkSocialAccount to get GitHub's OAuth start URL + Better
 * Auth's own state cookies, and redirect to that URL with all cookies
 * attached. When GitHub redirects back to Better Auth's callback, the
 * session cookie identifies the user and Better Auth creates the
 * `account` row scoped to them.
 */
export async function githubOauthBridge(c: Context) {
  const result = await startGithubLinkFromBridgeToken(c.req.query("token"));
  switch (result.kind) {
    case "missing-token":
      return c.html(
        renderCallbackHtml(
          "Missing bridge token",
          "GitHub OAuth bridge URL is malformed. Try connecting again from the dashboard.",
        ),
        400,
      );
    case "expired":
      return c.html(
        renderCallbackHtml(
          "OAuth link expired",
          "This GitHub OAuth bridge link expired or was already used. Try connecting again.",
        ),
        401,
      );
    case "redirect": {
      const response = c.redirect(result.url);
      for (const cookie of result.forwardCookies) response.headers.append("Set-Cookie", cookie);
      console.log(
        `[github oauth-bridge] hit userId=${result.userId} → GitHub OAuth (forwarded ${result.forwardedNames.length} state cookie(s): ${result.forwardedNames.join(", ")})`,
      );
      return response;
    }
    case "no-url":
      console.error(
        `[github oauth-bridge] linkSocialAccount returned no URL — status=${result.status} body=${result.bodySnippet}`,
      );
      return c.html(
        renderCallbackHtml(
          "OAuth start failed",
          "Could not start GitHub OAuth. Try again or check the server logs.",
        ),
        500,
      );
    case "failed":
      console.error("[github oauth-bridge] failed:", result.error);
      return c.html(
        renderCallbackHtml("OAuth start failed", result.error),
        500,
      );
  }
}

/**
 * GET /api/cloud/github/oauth-success   (PUBLIC)
 *
 * Better Auth redirects here after the GitHub OAuth callback completes
 * and the `account` row has been written. We just render a friendly
 * close-window page; the dashboard picks up the new state on its next
 * /user-status refresh.
 */
export async function githubOauthSuccess(c: Context) {
  return c.html(
    renderCallbackHtml(
      "GitHub connected",
      "Your GitHub account is now linked. You can close this window — the dashboard will refresh automatically.",
      { closeAfterMs: 2000 },
    ),
  );
}

/**
 * POST /api/cloud/github/install-url
 *
 * Returns the central App's installation URL with a one-time state token
 * embedded as a query parameter. GitHub Apps preserve the `state` query
 * param through the install flow and append it to the Setup URL alongside
 * `installation_id` and `setup_action` — that's what lets us attribute
 * the install back to the userId that started the flow without requiring
 * a SaaS session cookie on the popup browser (the App's Setup URL on
 * github.com should be pointed at /api/cloud/github/install-callback
 * below — that handler does the attribution).
 */
export async function githubInstallUrl(c: Context) {
  const ctx = getRequestContext(c);
  const { url, state } = await buildOrgScopedInstallUrl(ctx.organizationId);
  return c.json({ data: { url, state } });
}

/**
 * GET /api/cloud/github/install-callback?installation_id=X&setup_action=install&state=<token>
 *
 * Public endpoint (no session auth) — GitHub redirects the user's browser
 * here AFTER they approve the App installation on github.com. We use the
 * one-time state token (issued by githubInstallUrl and embedded into the
 * install URL) to recover the SaaS userId that started the flow, then
 * use the App-JWT (which only the SaaS holds) to read the installation
 * details and write the gitInstallation row. NO OAuth identity required.
 */
export async function githubInstallCallback(c: Context) {
  const result = await attributeGithubInstall({
    installationIdRaw: c.req.query("installation_id"),
    setupAction: c.req.query("setup_action"),
    state: c.req.query("state"),
    clientIp: c.var.clientIp,
    userAgent: c.req.header("user-agent") ?? null,
  });
  switch (result.kind) {
    case "missing-params":
      return c.html(
        renderCallbackHtml(
          "Missing parameters",
          "GitHub redirect did not include the expected parameters. Try installing again from the dashboard.",
        ),
        400,
      );
    case "state-expired":
      return c.html(
        renderCallbackHtml(
          "Install link expired",
          "This installation link expired or was already used. Start a new install from the dashboard.",
        ),
        400,
      );
    case "invalid-installation-id":
      return c.html(
        renderCallbackHtml(
          "Invalid installation",
          `installation_id="${result.raw}" is not a valid number.`,
        ),
        400,
      );
    case "pending-approval":
      return c.html(
        renderCallbackHtml(
          "Installation requested",
          "An organization admin needs to approve the install. The Openship App will activate once approved.",
        ),
      );
    case "ok":
      return c.html(
        renderCallbackHtml(
          "GitHub App installed",
          `${result.installation.account.login} is now connected. You can close this window — the dashboard will pick up the install on next refresh.`,
          { closeAfterMs: 2500 },
        ),
      );
    case "failed":
      console.error("[github install-callback] failed:", result.error);
      return c.html(
        renderCallbackHtml(
          "Install attribution failed",
          `Could not finalize installation ${result.installationId}. Refresh the dashboard or try installing again. (${result.error})`,
        ),
        500,
      );
  }
}

function renderCallbackHtml(
  title: string,
  message: string,
  opts?: { closeAfterMs?: number },
): string {
  const closeScript = opts?.closeAfterMs
    ? `<script>setTimeout(() => window.close(), ${opts.closeAfterMs});</script>`
    : "";
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)} · Openship</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; max-width: 480px; margin: 80px auto; padding: 24px; color: #1a1a1a; background: #fafafa; }
    .card { background: #fff; border-radius: 12px; padding: 32px; box-shadow: 0 1px 3px rgba(0,0,0,0.04), 0 8px 24px rgba(0,0,0,0.06); }
    h1 { font-size: 18px; font-weight: 600; margin: 0 0 12px; }
    p { font-size: 14px; line-height: 1.55; color: #555; margin: 0; }
  </style>
</head>
<body>
  <div class="card">
    <h1>${escapeHtml(title)}</h1>
    <p>${escapeHtml(message)}</p>
  </div>
  ${closeScript}
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

/**
 * GET /api/cloud/github/installations
 *
 * The org owner's GitHub installations — every team member sees the
 * same list because they all belong to the org whose owner connected
 * GitHub. Read-through to GitHub refreshes the DB cache.
 */
export async function githubInstallations(c: Context) {
  const ctx = getRequestContext(c);
  const installations = await listOrgInstallations(ctx.organizationId);
  return c.json({ data: installations });
}

/**
 * POST /api/cloud/github/installation-token  { owner, repos? }
 *
 * Mints a short-lived (~60min) installation access token for the given
 * owner. Cloud signs the JWT with its private key and hits GitHub's
 * /access_tokens endpoint. Local uses the returned token directly
 * against github.com for the actual git clone — cloud never sees the
 * source code.
 *
 * SECURITY: `installationId` is intentionally NOT accepted from the
 * request body — see service comments.
 */
export async function githubInstallationToken(c: Context) {
  const ctx = getRequestContext(c);
  const body = await c.req.json<{ owner?: string; repos?: string[] }>();
  if (!body.owner) return c.json({ error: "owner is required" }, 400);
  const result = await mintOrgInstallationToken(ctx.organizationId, body.owner, body.repos);
  if (result.kind === "not-found") {
    return c.json({ error: `No GitHub App installation found for ${result.owner}` }, 404);
  }
  return c.json({ data: { token: result.token, expiresAt: result.expiresAt } });
}

/**
 * GET /api/cloud/github/user-status
 * The cloud-resolved OAuth identity (login, avatar) for the calling user.
 * Local renders this in the GitHub settings panel; the OAuth account itself
 * lives in cloud's Better-Auth, NOT in the self-hosted instance.
 */
export async function githubUserStatus(c: Context) {
  const ctx = getRequestContext(c);
  const status = await githubAuth.getUserStatusWithDiagnostics(ctx.userId);
  if (!status.connected) {
    console.log(
      `[cloud-saas:githubUserStatus] connected=false userId=${ctx.userId} githubAccountRowsForUser=${status.githubAccountRowsForUser}`,
    );
    return c.json({ data: { connected: false as const } });
  }
  return c.json({
    data: {
      connected: true as const,
      login: status.login,
      avatarUrl: status.avatar_url,
      id: status.id,
    },
  });
}
