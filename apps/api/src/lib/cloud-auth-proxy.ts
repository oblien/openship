/**
 * Cloud auth proxy - shared utilities for Openship Cloud authentication.
 *
 * Used by:
 *   - Desktop mode: cloud-callback exchanges a one-time code for a local session
 *   - Self-hosted settings: connect-callback stores cloud token for deploys
 *   - Cloud mode (SaaS): desktop-handoff generates one-time codes
 *
 * All external auth happens on app.openship.io - this module only handles
 * the local side (mirroring users, creating sessions, managing codes).
 */

import { randomUUID, randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { db, schema, repos, eq } from "@repo/db";
import { encrypt } from "@repo/platform/engine/lib/encryption";
import { provisionUser } from "@repo/platform/engine/lib/provision-user";
import { cloudRuntimeTarget, env } from "@repo/platform/engine/config/env";
import { safeErrorMessage } from "@repo/core";

export interface CloudUser {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  image?: string | null;
}

/**
 * Ensure a local user record exists that mirrors the cloud user.
 *
 * Uses the cloud user's email as the unique key. If the user already
 * exists locally (from a previous login), updates their info.
 * Returns the local user ID.
 */
async function mirrorCloudUser(cloudUser: CloudUser): Promise<string> {
  const existing = await repos.user.findByEmail(cloudUser.email);

  if (existing) {
    // Keep the mirror in sync with cloud-side identity changes.
    await db
      .update(schema.user)
      .set({
        name: cloudUser.name,
        image: cloudUser.image,
        emailVerified: true,
      })
      .where(eq(schema.user.email, cloudUser.email));
  }

  // Provision (idempotent) handles user insert + personal org + owner
  // membership atomically. For existing users it's a no-op on the
  // identity row; for new users it inserts everything in one
  // transaction.
  const id = existing?.id ?? cloudUser.id;
  await provisionUser({
    id,
    name: cloudUser.name,
    email: cloudUser.email,
    emailVerified: true,
    role: "admin",
    image: cloudUser.image,
  });

  return id;
}

/**
 * Store the cloud session token (encrypted) for later cloud API calls.
 *
 * After storing, wipe every cache derived from the cloud session
 * (validated-connection, profile, namespace token, and GitHub caches).
 * A fresh connect must reflect atomically — a stale "disconnected"
 * cache or an old user's namespace token would otherwise linger up to
 * its TTL and make the just-connected user look disconnected / wrong.
 */
async function storeCloudSession(userId: string, cloudSessionToken: string): Promise<void> {
  const encrypted = encrypt(cloudSessionToken);
  const settings = await repos.settings.findByUser(userId);
  if (settings) {
    await repos.settings.update(userId, { cloudSessionToken: encrypted });
  } else {
    await repos.settings.upsert({
      id: randomUUID(),
      userId,
      cloudSessionToken: encrypted,
    });
  }
  const { invalidateCloudCaches } = await import("@repo/platform/engine/lib/cloud/session");
  await invalidateCloudCaches(userId);
}

/**
 * Create a local Better Auth session directly in the DB.
 *
 * This is used for desktop/cloud-proxy auth where we don't have a local password.
 * The session is created for the mirrored user so that `auth.api.getSession()`
 * recognizes it from the cookie.
 *
 * Returns the session token (to be set as a cookie).
 */
/**
 * Mint a session row directly via Drizzle. Bypasses Better Auth's
 * `session.create.before` hook because the caller has already done
 * the equivalent work (user provisioning, org resolution).
 *
 * Two `purpose` values exist:
 *   - `"local-cookie"` — the row backing the browser cookie session
 *     created by desktop / cloud-callback / upgrade-to-auth flows.
 *     `id` is a UUID, no prefix. `activeOrganizationId` defaults to
 *     the user's deterministic personal org `org_<userId>`.
 *   - `"linked-instance"` — the bearer-only row created at
 *     connect-authorize for a remote local instance. `id` is prefixed
 *     `sess_link_` so audit / forensics can tell linked-instance
 *     sessions apart from browser sessions. Caller MUST pass
 *     `activeOrganizationId` (the linked org context).
 *
 * Distinguishing the two purposes by id-prefix means
 * `POST /api/cloud/disconnect` deletes ONLY the linked row by its
 * session.id, never touching the cookie row even though both live in
 * the same `session` table.
 */
export async function mintSession(opts: {
  purpose: "local-cookie" | "linked-instance";
  userId: string;
  activeOrganizationId?: string;
  ipAddress?: string | null;
  userAgent?: string | null;
  ttlSeconds?: number;
}): Promise<{ id: string; token: string; expiresAt: Date }> {
  const id =
    opts.purpose === "linked-instance"
      ? `sess_link_${randomBytes(12).toString("hex")}`
      : randomUUID();
  const token = randomBytes(32).toString("hex");
  const now = new Date();
  const expiresAt = new Date(
    now.getTime() + (opts.ttlSeconds ?? 60 * 60 * 24 * 30) * 1000,
  );
  const defaultUserAgent =
    opts.purpose === "linked-instance" ? "openship-local-link" : null;

  await db.insert(schema.session).values({
    id,
    token,
    userId: opts.userId,
    expiresAt,
    ipAddress: opts.ipAddress ?? null,
    userAgent: opts.userAgent ?? defaultUserAgent,
    activeOrganizationId:
      opts.activeOrganizationId ?? `org_${opts.userId}`,
    createdAt: now,
    updatedAt: now,
  });

  return { id, token, expiresAt };
}

// ─── One-time handoff codes (cloud-side generates, desktop-side consumes) ────
//
// DB-BACKED. Codes survive process restarts (dev --watch, prod rolling
// deploys, k8s pod recycles) and work across multi-instance SaaS pods.
//
// Schema: cloud_handoff_code (code PK, user_data jsonb, session_token,
// code_challenge nullable, expires_at, created_at). See packages/db/src/
// schema/cloud-handoff-code.ts.
//
// One-time use is enforced by an atomic DELETE ... RETURNING in the
// consume path — no race between SELECT and DELETE, so a code can only
// be exchanged exactly once even under concurrent requests.

const HANDOFF_TTL_MS = 60_000;

/**
 * Generate a one-time code that holds the auth result.
 * Called on the CLOUD instance after authentication completes.
 *
 * @param codeChallenge - PKCE S256 challenge (base64url). When provided,
 *   the corresponding code_verifier must be presented at exchange time.
 */
async function generateHandoffCode(
  user: CloudUser,
  sessionToken: string,
  codeChallenge?: string,
  state?: string,
): Promise<string> {
  // Lazy purge — cheap, runs at most once per minute via inserts.
  await repos.cloudHandoffCode.purgeExpired().catch(() => undefined);

  const code = randomBytes(32).toString("hex");
  await repos.cloudHandoffCode.create({
    code,
    userData: {
      id: user.id,
      name: user.name ?? null,
      email: user.email ?? null,
      emailVerified: user.emailVerified ?? null,
      image: user.image ?? null,
    },
    sessionToken,
    codeChallenge: codeChallenge ?? null,
    // Recorded so the device/poll flow can retrieve this code by `state`.
    state: state ?? null,
    expiresAt: new Date(Date.now() + HANDOFF_TTL_MS),
  });
  return code;
}

/**
 * Device/poll flow: look up the one-time code minted for a CLI-generated
 * `state`. Returns the opaque code (still PKCE-locked + one-time at exchange)
 * or null while the user hasn't approved yet / after TTL. NON-destructive so
 * the CLI can poll idempotently.
 */
async function findHandoffCodeByState(state: string): Promise<string | null> {
  const row = await repos.cloudHandoffCode.findByState(state).catch(() => null);
  return row?.code ?? null;
}

/**
 * Exchange a one-time code for the auth result.
 * Called on the CLOUD instance by the desktop/local callback.
 *
 * Atomic DELETE ... RETURNING — the lookup AND the one-time-use guard
 * are a single SQL statement; concurrent exchanges of the same code
 * see exactly one success.
 *
 * If a code_challenge was stored, the caller must provide the matching
 * code_verifier (PKCE S256). Returns null on mismatch.
 */
async function exchangeHandoffCode(
  code: string,
  codeVerifier?: string,
): Promise<{ user: CloudUser; sessionToken: string } | null> {
  const row = await repos.cloudHandoffCode.consume(code);
  if (!row) {
    console.error(
      `[handoff-exchange-miss] code=${code.slice(0, 12)}… ` +
        `not found in DB or already expired/consumed.`,
    );
    return null;
  }

  // PKCE verification — if a challenge was stored, verifier is mandatory
  if (row.codeChallenge) {
    if (!codeVerifier) {
      console.warn(`[handoff] PKCE: code_verifier required but not provided`);
      return null;
    }
    const computed = createHash("sha256")
      .update(codeVerifier)
      .digest("base64url");
    if (computed !== row.codeChallenge) {
      console.warn(`[handoff] PKCE mismatch`);
      return null;
    }
  }

  const user: CloudUser = {
    id: row.userData.id,
    name: row.userData.name ?? "",
    email: row.userData.email ?? "",
    emailVerified: row.userData.emailVerified ?? false,
    image: row.userData.image ?? null,
  };
  return { user, sessionToken: row.sessionToken };
}

/**
 * Exchange a one-time code with the Openship Cloud API.
 * Shared by desktop cloud-callback and self-hosted connect-callback.
 *
 * @param codeVerifier - PKCE code_verifier (plain). Required when the
 *   authorization was initiated with a code_challenge.
 */
async function exchangeCodeWithCloud(
  code: string,
  codeVerifier?: string,
): Promise<{ user: CloudUser; sessionToken: string } | null> {
  const url = `${cloudRuntimeTarget.api}/api/cloud/exchange-code`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, code_verifier: codeVerifier }),
    });
  } catch (err) {
    // Network error (DNS, ECONNREFUSED, timeout). The cloud SaaS is
    // unreachable from this host. Log so the operator can see WHY the
    // connect popup says "Connection Failed".
    console.error(
      `[cloud-auth] exchange-code fetch failed: ${url} — ${
        safeErrorMessage(err)
      }`,
    );
    return null;
  }
  if (!res.ok) {
    console.error(
      `[cloud-auth] exchange-code returned ${res.status} from ${url}`,
    );
    return null;
  }
  // Defensive parse: cloud returning HTML (404 page / captive portal /
  // dev server with no route) is the dominant failure mode. Don't let
  // it throw the whole connect-callback handler.
  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    console.error(
      `[cloud-auth] exchange-code returned non-JSON (content-type=${contentType}) from ${url}`,
    );
    return null;
  }
  try {
    const { data } = (await res.json()) as {
      data: { user: CloudUser; sessionToken: string };
    };
    return data ?? null;
  } catch (err) {
    console.error(
      `[cloud-auth] exchange-code JSON parse failed: ${
        safeErrorMessage(err)
      }`,
    );
    return null;
  }
}

// ─── Desktop auth nonce relay (single-user, in-memory) ──────────────────────

/**
 * When Electron starts cloud auth, it registers a nonce.
 * After the system browser completes /cloud-callback, the session token
 * is stored against that nonce. Electron polls to pick it up.
 */
let pendingNonce: { value: string; state: string; codeVerifier: string; connectUserId?: string; registeredAt: number } | null = null;
let resolvedAuth: { nonce: string; claimCode: string } | null = null;
let pendingClaim: { code: string; token: string; expiresAt: number; createdAt: number } | null = null;
/** Nonce value preserved after validateDesktopState consumes pendingNonce, used by pollDesktopAuth */
let activeNonce: string | null = null;
let activeNonceCreatedAt = 0;
/** Set when exchange/mirroring fails so polling returns "expired" immediately */
let failedNonce: string | null = null;

const NONCE_TTL = 5 * 60 * 1000; // 5 minutes

function registerDesktopNonce(nonce: string, state: string, codeVerifier: string, connectUserId?: string): void {
  console.log(`[desktop-auth] register nonce=${nonce.slice(0, 8)}… state=${state.slice(0, 8)}…`);
  pendingNonce = { value: nonce, state, codeVerifier, connectUserId, registeredAt: Date.now() };
  resolvedAuth = null;
  pendingClaim = null;
  activeNonce = nonce;
  activeNonceCreatedAt = Date.now();
  failedNonce = null;
}

/**
 * Store the session result so Electron can pick it up via polling.
 *
 * The nonce value needed for polling was saved at registerDesktopNonce time.
 * validateDesktopState already consumed pendingNonce, so we accept the
 * nonce value explicitly.
 */
function resolveDesktopAuth(nonce: string, token: string, expiresAt: Date): void {
  const claimCode = randomBytes(16).toString("hex");
  resolvedAuth = { nonce, claimCode };
  pendingClaim = { code: claimCode, token, expiresAt: expiresAt.getTime(), createdAt: Date.now() };
  console.log(`[desktop-auth] resolved nonce=${nonce.slice(0, 8)}… claimCode=${claimCode.slice(0, 8)}…`);
}

/**
 * Validate the state parameter returned from the cloud and retrieve
 * the stored code_verifier for PKCE.
 *
 * Returns the code_verifier and nonce if state matches, null otherwise.
 * Consumes the nonce atomically - prevents replay attacks.
 */
function validateDesktopState(state: string): { codeVerifier: string; nonce: string; connectUserId?: string } | null {
  if (!pendingNonce) {
    console.log(`[desktop-auth] validateState: no pendingNonce`);
    return null;
  }
  if (Date.now() - pendingNonce.registeredAt > NONCE_TTL) {
    pendingNonce = null;
    return null;
  }
  // Timing-safe comparison for state
  const expected = Buffer.from(pendingNonce.state);
  const actual = Buffer.from(state);
  if (expected.length !== actual.length) {
    pendingNonce = null;
    return null;
  }
  if (!timingSafeEqual(expected, actual)) {
    pendingNonce = null;
    return null;
  }
  const result = { codeVerifier: pendingNonce.codeVerifier, nonce: pendingNonce.value, connectUserId: pendingNonce.connectUserId };
  pendingNonce = null; // consume - one-time use
  return result;
}

/** Signal that the exchange/mirror step failed so polling stops. */
function failDesktopAuth(nonce: string): void {
  failedNonce = nonce;
  activeNonce = null;
}

function pollDesktopAuth(nonce: string): { status: "pending" | "resolved" | "expired"; claimCode?: string } {
  if (resolvedAuth && resolvedAuth.nonce === nonce) {
    const result = { status: "resolved" as const, claimCode: resolvedAuth.claimCode };
    console.log(`[desktop-auth] poll → resolved nonce=${nonce.slice(0, 8)}…`);
    resolvedAuth = null; // one-time read
    activeNonce = null;
    return result;
  }
  if (failedNonce === nonce) {
    failedNonce = null;
    return { status: "expired" };
  }
  if (pendingNonce && pendingNonce.value === nonce) {
    if (Date.now() - pendingNonce.registeredAt > NONCE_TTL) {
      pendingNonce = null;
      activeNonce = null;
      return { status: "expired" };
    }
    return { status: "pending" };
  }
  // Between validateDesktopState (consumes pendingNonce) and resolveDesktopAuth
  // (sets resolvedAuth), both are null. activeNonce keeps "pending" during this window.
  if (activeNonce === nonce) {
    if (Date.now() - activeNonceCreatedAt > NONCE_TTL) {
      activeNonce = null;
      return { status: "expired" };
    }
    return { status: "pending" };
  }
  return { status: "expired" };
}

function exchangeDesktopClaim(code: string): { token: string; expiresAt: Date } | null {
  if (!pendingClaim || pendingClaim.code !== code) {
    console.log(`[desktop-auth] claim failed: ${!pendingClaim ? 'no pendingClaim' : 'code mismatch'}`);
    return null;
  }
  if (Date.now() - pendingClaim.createdAt > 60_000) {
    console.log(`[desktop-auth] claim expired (age=${Date.now() - pendingClaim.createdAt}ms)`);
    pendingClaim = null;
    return null;
  }
  console.log(`[desktop-auth] claim exchanged OK`);
  const result = { token: pendingClaim.token, expiresAt: new Date(pendingClaim.expiresAt) };
  pendingClaim = null; // one-time use
  return result;
}

/** Read the current active nonce (used by catch blocks that don't have it). */
function getActiveNonce(): string | null {
  return activeNonce;
}

// ─── Desktop + connect handoff URL validation + construction ────────────────
//
// Extracted from cloud-saas.controller's desktopHandoff / connectHandoff
// handlers so the URL-validation policy (localhost-only for desktop,
// HTTPS-or-localhost for connect, ≥1024 port for both) lives in one
// testable place. The handlers themselves become thin: validate →
// generate code → redirect.

type ValidationFailure = { ok: false; status: 400; error: string };
type ValidationSuccess = { ok: true; url: URL };
type ValidationResult = ValidationSuccess | ValidationFailure;

/**
 * Parse a redirect string into a URL, rejecting empty input, invalid
 * syntax, and any URL carrying userinfo (user:pass@host) — credentials
 * in the URL are a well-known phishing/spoofing vector and have no
 * business in an OAuth-style redirect.
 */
function parseRedirectUrl(redirect: string | undefined): ValidationResult {
  if (!redirect) {
    return { ok: false, status: 400, error: "Missing redirect parameter" };
  }
  let url: URL;
  try {
    url = new URL(redirect);
  } catch {
    return { ok: false, status: 400, error: "Invalid redirect URL" };
  }
  if (url.username || url.password) {
    return { ok: false, status: 400, error: "Redirect URL must not contain userinfo" };
  }
  return { ok: true, url };
}

function isLocalhostHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1";
}

/**
 * For localhost redirects, require a port ≥1024 to avoid privileged
 * ports (which would imply a system-level service, not an ephemeral
 * desktop / dev callback listener).
 */
function checkLocalhostPort(url: URL): ValidationFailure | null {
  const port = parseInt(url.port || "80", 10);
  if (port < 1024 || port > 65535) {
    return { ok: false, status: 400, error: "Redirect port must be ≥ 1024" };
  }
  return null;
}

export function validateDesktopRedirect(redirect: string | undefined): ValidationResult {
  const parsed = parseRedirectUrl(redirect);
  if (!parsed.ok) return parsed;
  const { url } = parsed;
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, status: 400, error: "Redirect must use http or https" };
  }
  if (!isLocalhostHostname(url.hostname)) {
    return { ok: false, status: 400, error: "Redirect must target localhost" };
  }
  const portError = checkLocalhostPort(url);
  if (portError) return portError;
  return { ok: true, url };
}

export function validateConnectRedirect(redirect: string | undefined): ValidationResult {
  const parsed = parseRedirectUrl(redirect);
  if (!parsed.ok) return parsed;
  const { url } = parsed;
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, status: 400, error: "Redirect must use http or https" };
  }
  if (isLocalhostHostname(url.hostname)) {
    const portError = checkLocalhostPort(url);
    if (portError) return portError;
  } else if (url.protocol !== "https:") {
    return { ok: false, status: 400, error: "Redirect must use HTTPS" };
  }
  return { ok: true, url };
}

interface HandoffSession {
  user: {
    id: string;
    name: string;
    email: string;
    emailVerified: boolean;
    image?: string | null;
  };
  session: { token: string };
}

/**
 * Unified handoff builder for both desktop (localhost callback) and
 * connect (self-hosted callback) flows.
 *
 *   - When `session` is null, redirects the browser to the SaaS /login
 *     page with `?callback=<redirect>` so post-auth routing can resume
 *     the handoff. `loginFlow` (when provided) becomes `?flow=` on the
 *     login URL — desktop callers pass "desktop-cloud" so the SaaS
 *     post-auth router knows to route to /authorize; connect callers
 *     omit it.
 *   - When `session` is present, generates a one-time handoff code
 *     (PKCE-bound when `codeChallenge` is supplied) and redirects the
 *     browser to the final callback URL with `?code=<code>` (and
 *     `?state=<state>` if state was supplied).
 *
 * Both `state` and `codeChallenge` are accepted in both flows — the
 * connect flow used to ignore them, which made connect codes
 * unprotected bearer tokens exfiltratable via CSRF on the
 * /connect-handoff GET endpoint.
 */
export async function buildAuthHandoff(opts: {
  session: HandoffSession | null;
  redirect: URL;
  state?: string;
  codeChallenge?: string;
  dashboardOrigin: string;
  loginFlow?: string;
}): Promise<{ kind: "login"; url: string } | { kind: "handoff"; url: string }> {
  if (!opts.session) {
    const loginUrl = new URL("/login", opts.dashboardOrigin);
    loginUrl.searchParams.set("callback", opts.redirect.toString());
    if (opts.loginFlow) loginUrl.searchParams.set("flow", opts.loginFlow);
    if (opts.state) loginUrl.searchParams.set("state", opts.state);
    if (opts.codeChallenge) loginUrl.searchParams.set("code_challenge", opts.codeChallenge);
    return { kind: "login", url: loginUrl.toString() };
  }

  const code = await generateHandoffCode(
    {
      id: opts.session.user.id,
      name: opts.session.user.name,
      email: opts.session.user.email,
      emailVerified: opts.session.user.emailVerified,
      image: opts.session.user.image ?? null,
    },
    opts.session.session.token,
    opts.codeChallenge || undefined,
    opts.state || undefined,
  );

  const url = new URL(opts.redirect.toString());
  url.searchParams.set("code", code);
  if (opts.state) url.searchParams.set("state", opts.state);
  return { kind: "handoff", url: url.toString() };
}

export {
  mirrorCloudUser,
  storeCloudSession,
  generateHandoffCode,
  findHandoffCodeByState,
  exchangeHandoffCode,
  exchangeCodeWithCloud,
  registerDesktopNonce,
  resolveDesktopAuth,
  failDesktopAuth,
  validateDesktopState,
  pollDesktopAuth,
  exchangeDesktopClaim,
  getActiveNonce,
};
