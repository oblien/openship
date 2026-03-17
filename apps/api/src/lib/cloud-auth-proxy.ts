/**
 * Cloud auth proxy — shared utilities for Openship Cloud authentication.
 *
 * Used by:
 *   - Desktop mode: cloud-callback exchanges a one-time code for a local session
 *   - Self-hosted settings: connect-callback stores cloud token for deploys
 *   - Cloud mode (SaaS): desktop-handoff generates one-time codes
 *
 * All external auth happens on app.openship.io — this module only handles
 * the local side (mirroring users, creating sessions, managing codes).
 */

import { randomUUID, randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { db, schema, repos, eq } from "@repo/db";
import { encrypt } from "./encryption";
import { env } from "../config/env";

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
    // Update name/image if changed
    await db
      .update(schema.user)
      .set({
        name: cloudUser.name,
        image: cloudUser.image,
        emailVerified: true,
      })
      .where(eq(schema.user.email, cloudUser.email));
    return existing.id;
  }

  // Create new local user — use a deterministic ID so cloud user maps 1:1
  const id = cloudUser.id;
  await db.insert(schema.user).values({
    id,
    name: cloudUser.name,
    email: cloudUser.email,
    emailVerified: true,
    role: "admin",
    autoProvisioned: false,
  });

  return id;
}

/**
 * Store the cloud session token (encrypted) for later cloud API calls.
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
async function createLocalSession(
  userId: string,
  ipAddress?: string,
  userAgent?: string,
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days

  await db.insert(schema.session).values({
    id: randomUUID(),
    token,
    userId,
    expiresAt,
    ipAddress: ipAddress ?? null,
    userAgent: userAgent ?? null,
  });

  return { token, expiresAt };
}

// ─── One-time handoff codes (cloud-side generates, desktop-side consumes) ────

/**
 * In-memory store for one-time handoff codes.
 * Code → { user, sessionToken, expiresAt }
 *
 * Used by CLOUD_MODE instances to hold auth data between the
 * auth completion and the desktop/local instance's code exchange.
 */
const handoffCodes = new Map<string, { user: CloudUser; sessionToken: string; codeChallenge: string | null; expiresAt: number }>();

let lastPurge = 0;
function purgeExpiredCodes() {
  const now = Date.now();
  if (now - lastPurge < 60_000) return;
  lastPurge = now;
  for (const [code, data] of handoffCodes) {
    if (data.expiresAt < now) handoffCodes.delete(code);
  }
}

/**
 * Generate a one-time code that holds the auth result.
 * Called on the CLOUD instance after authentication completes.
 * The code is valid for 60 seconds and can only be used once.
 *
 * @param codeChallenge — PKCE S256 challenge (base64url). When provided,
 *   the corresponding code_verifier must be presented at exchange time.
 */
async function generateHandoffCode(user: CloudUser, sessionToken: string, codeChallenge?: string): Promise<string> {
  purgeExpiredCodes();
  const code = randomBytes(32).toString("hex");
  handoffCodes.set(code, {
    user,
    sessionToken,
    codeChallenge: codeChallenge ?? null,
    expiresAt: Date.now() + 60_000,
  });
  return code;
}

/**
 * Exchange a one-time code for the auth result.
 * Called on the CLOUD instance by the desktop/local callback.
 *
 * If a code_challenge was stored, the caller must provide the matching
 * code_verifier (PKCE S256). Returns null on mismatch.
 */
function exchangeHandoffCode(code: string, codeVerifier?: string): { user: CloudUser; sessionToken: string } | null {
  purgeExpiredCodes();
  const data = handoffCodes.get(code);
  if (!data || data.expiresAt < Date.now()) {
    handoffCodes.delete(code);
    return null;
  }

  // PKCE verification — if a challenge was stored, verifier is mandatory
  if (data.codeChallenge) {
    if (!codeVerifier) {
      return null; // verifier required but not provided
    }
    const computed = createHash("sha256").update(codeVerifier).digest("base64url");
    if (computed !== data.codeChallenge) {
      return null; // PKCE mismatch
    }
  }

  handoffCodes.delete(code); // one-time use
  return { user: data.user, sessionToken: data.sessionToken };
}

/**
 * Exchange a one-time code with the Openship Cloud API.
 * Shared by desktop cloud-callback and self-hosted connect-callback.
 *
 * @param codeVerifier — PKCE code_verifier (plain). Required when the
 *   authorization was initiated with a code_challenge.
 */
async function exchangeCodeWithCloud(code: string, codeVerifier?: string): Promise<{ user: CloudUser; sessionToken: string } | null> {
  const res = await fetch(`${env.OPENSHIP_CLOUD_URL}/api/cloud/exchange-code`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, code_verifier: codeVerifier }),
  });
  if (!res.ok) return null;
  const { data } = (await res.json()) as {
    data: { user: CloudUser; sessionToken: string };
  };
  return data;
}

// ─── Desktop auth nonce relay (single-user, in-memory) ──────────────────────

/**
 * When Electron starts cloud auth, it registers a nonce.
 * After the system browser completes /cloud-callback, the session token
 * is stored against that nonce. Electron polls to pick it up.
 */
let pendingNonce: { value: string; state: string; codeVerifier: string; registeredAt: number } | null = null;
let resolvedAuth: { nonce: string; claimCode: string } | null = null;
let pendingClaim: { code: string; token: string; expiresAt: number; createdAt: number } | null = null;
/** Nonce value preserved after validateDesktopState consumes pendingNonce, used by pollDesktopAuth */
let activeNonce: string | null = null;

const NONCE_TTL = 5 * 60 * 1000; // 5 minutes

function registerDesktopNonce(nonce: string, state: string, codeVerifier: string): void {
  pendingNonce = { value: nonce, state, codeVerifier, registeredAt: Date.now() };
  resolvedAuth = null;
  pendingClaim = null;
  activeNonce = nonce;
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
}

/**
 * Validate the state parameter returned from the cloud and retrieve
 * the stored code_verifier for PKCE.
 *
 * Returns the code_verifier and nonce if state matches, null otherwise.
 * Consumes the nonce atomically — prevents replay attacks.
 */
function validateDesktopState(state: string): { codeVerifier: string; nonce: string } | null {
  if (!pendingNonce) return null;
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
  const result = { codeVerifier: pendingNonce.codeVerifier, nonce: pendingNonce.value };
  pendingNonce = null; // consume — one-time use
  return result;
}

function pollDesktopAuth(nonce: string): { status: "pending" | "resolved" | "expired"; claimCode?: string } {
  if (resolvedAuth && resolvedAuth.nonce === nonce) {
    const result = { status: "resolved" as const, claimCode: resolvedAuth.claimCode };
    resolvedAuth = null; // one-time read
    activeNonce = null;
    return result;
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
    return { status: "pending" };
  }
  return { status: "expired" };
}

function exchangeDesktopClaim(code: string): { token: string; expiresAt: Date } | null {
  if (!pendingClaim || pendingClaim.code !== code) return null;
  if (Date.now() - pendingClaim.createdAt > 60_000) {
    pendingClaim = null;
    return null;
  }
  const result = { token: pendingClaim.token, expiresAt: new Date(pendingClaim.expiresAt) };
  pendingClaim = null; // one-time use
  return result;
}

export {
  mirrorCloudUser,
  storeCloudSession,
  createLocalSession,
  generateHandoffCode,
  exchangeHandoffCode,
  exchangeCodeWithCloud,
  registerDesktopNonce,
  resolveDesktopAuth,
  validateDesktopState,
  pollDesktopAuth,
  exchangeDesktopClaim,
};
