/**
 * GitHub local auth - resolves GitHub credentials from the machine's `gh` CLI.
 *
 * Used in local / desktop mode where there is no GitHub App and no OAuth
 * callback. Users authenticate via `gh auth login` on their machine and
 * we piggyback on that token.
 *
 * Resolution order:
 *   1. `gh auth token` subprocess (works on any OS where `gh` is in PATH)
 *   2. Read `~/.config/gh/hosts.yml` directly (fallback when `gh` binary is missing)
 *
 * This module also exposes `getLocalGhStatus()` - a convenience that validates
 * the resolved token against the GitHub API and returns the user profile.
 *
 * SAFETY (two layers):
 *   1. HARD floor — the token-resolving entrypoints (getLocalGhToken,
 *      getLocalGhStatus, startDeviceFlow) return null / unavailable / throw
 *      immediately when `env.CLOUD_MODE` is set, BEFORE any subprocess or
 *      disk read. This is independent of GITHUB_AUTH_MODE, so the SaaS host
 *      can never shell out to `gh` even if misconfigured with
 *      GITHUB_AUTH_MODE=cli (which env.ts also rejects at boot).
 *   2. Mode no-op — those same entrypoints also no-op when the resolved
 *      `getGitHubAuthMode()` is "app" or "oauth".
 * The listing helpers (listLocalGhRepos/listLocalGhOrgs) carry no guard of
 * their own; they inherit both layers by calling getLocalGhToken() first
 * and bailing on null.
 */

import { execFile } from "child_process";
import { readFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";
import { createOAuthDeviceAuth } from "@octokit/auth-oauth-device";
import { repos } from "@repo/db";
import { env } from "../../config/env";
import { cacheStore } from "../../lib/cache-store";
import { decrypt, encrypt } from "../../lib/encryption";
import { systemDebug } from "../../lib/system-debug";
import { ghFetchSoft } from "./github.http";
import { getGitHubAuthMode } from "./github.auth";
import { safeErrorMessage } from "@repo/core";

// ─── Cache ───────────────────────────────────────────────────────────────────

const GH_CLI_TOKEN_TTL_S = 5 * 60;
const GH_CLI_TOKEN_KEY = "local:gh-cli-token";

// ─── Token resolution ────────────────────────────────────────────────────────

/**
 * Resolve the GitHub token from the local `gh` CLI.
 * Result is cached for 5 minutes to avoid shelling out on every request.
 * Returns null immediately in cloud modes (app / oauth).
 */
export async function getLocalGhToken(): Promise<string | null> {
  // HARD multi-tenant floor: on the SaaS host (CLOUD_MODE) the gh CLI must
  // NEVER run — no subprocess, no hosts.yml read, no token. This check is
  // INDEPENDENT of getGitHubAuthMode(): a host booted with
  // GITHUB_AUTH_MODE=cli would otherwise resolve mode "cli" and slip past
  // the app/oauth check below, executing `gh` on the multi-tenant box.
  // env.ts also rejects that combo at boot; this is the source-level
  // belt-and-suspenders.
  if (env.CLOUD_MODE) return null;

  const mode = getGitHubAuthMode();
  if (mode === "app" || mode === "oauth") return null;

  const store = await cacheStore<string>("gh-cli-token");
  const cached = await store.get(GH_CLI_TOKEN_KEY);
  if (cached) return cached;

  // Durable device-flow token BEFORE the `gh` probes. It has to be in this chain
  // and not just in the cache: the two probes below read a `gh` binary and
  // ~/.config/gh/hosts.yml, neither of which exists in the api container, so a
  // cache miss there meant "signed out" for the exact install the device flow
  // serves. Re-populates the cache so the hot path stays a single memory hit.
  const stored = await readStoredDeviceToken();
  if (stored) {
    await store.set(GH_CLI_TOKEN_KEY, stored, GH_CLI_TOKEN_TTL_S);
    return stored;
  }

  let token = await ghAuthTokenViaCli();
  if (!token) token = await ghAuthTokenViaConfig();
  if (token) await store.set(GH_CLI_TOKEN_KEY, token, GH_CLI_TOKEN_TTL_S);
  return token;
}

/**
 * The device-flow token from `instance_settings`, decrypted. Soft: a missing row,
 * a null column or an undecryptable value all mean "no stored token" and fall
 * through to the `gh` probes rather than failing the caller.
 *
 * A decrypt failure is worth a log — it means the row survived but the key no
 * longer opens it, and the operator has to sign in again. The key is derived
 * from BETTER_AUTH_SECRET (see lib/encryption), so rotating THAT is what
 * orphans a stored credential.
 */
async function readStoredDeviceToken(): Promise<string | null> {
  try {
    const settings = await repos.instanceSettings.get();
    const sealed = settings?.ghDeviceTokenEncrypted;
    if (!sealed) return null;
    return decrypt(sealed);
  } catch (err) {
    systemDebug("github", `stored device token unreadable: ${safeErrorMessage(err)}`);
    return null;
  }
}

/**
 * Persist (or clear) the device-flow token. Encrypted at rest with the same key
 * as every other stored secret, and mirrored into the short cache so the sign-in
 * takes effect without waiting on a read-through.
 */
export async function setStoredDeviceToken(
  token: string | null,
  method: "device" | "token" = "device",
): Promise<void> {
  await repos.instanceSettings.upsert(
    token
      ? {
          ghDeviceTokenEncrypted: encrypt(token),
          ghDeviceTokenSetAt: new Date(),
          ghDeviceTokenMethod: method,
        }
      : { ghDeviceTokenEncrypted: null, ghDeviceTokenSetAt: null, ghDeviceTokenMethod: null },
  );
  const store = await cacheStore<string>("gh-cli-token");
  if (token) await store.set(GH_CLI_TOKEN_KEY, token, GH_CLI_TOKEN_TTL_S);
  else await store.delete(GH_CLI_TOKEN_KEY);
}

/**
 * How the instance's git identity was established, for labelling and for the
 * consent decision. "host-cli" = probed off the host's own `gh` login (nothing
 * the operator did inside Openship); "device"/"token" = they connected it here.
 */
export type GitIdentityMethod = "host-cli" | "device" | "token";

/**
 * Why a credential that EXISTS can't be used. Absent when there is no
 * credential at all — "nothing connected" and "what you connected is broken"
 * are different states and the UI has to be able to tell them apart.
 *
 *   "rejected"    → GitHub answered 401/403: revoked, expired, or scope-stripped.
 *                   Actionable, and the only one worth alarming about.
 *   "unreachable" → we never got an answer (DNS, offline, proxy). The credential
 *                   may be perfectly fine, so this must NOT read as "invalid".
 */
export type GitIdentityProblem = "rejected" | "unreachable";

export async function getGitIdentityMethod(): Promise<GitIdentityMethod | null> {
  if (env.CLOUD_MODE) return null;
  const stored = await repos.instanceSettings.get().catch(() => null);
  if (stored?.ghDeviceTokenEncrypted) return stored.ghDeviceTokenMethod ?? "device";
  return (await getLocalGhToken()) ? "host-cli" : null;
}

/**
 * Is there a local git identity this host could FORWARD (never ship) to a build
 * host? The single definition of the relay's real precondition: the relay's
 * remote helper vends `getLocalGhToken()`, so without one the tunnel would open
 * and answer nothing. Shared by the deploy pipeline (clone-auth) and preflight so
 * preflight can never predict a relay the pipeline won't take. Soft — any failure
 * means "no".
 */
export async function hasLocalGitIdentity(): Promise<boolean> {
  try {
    return !!(await getLocalGhToken());
  } catch {
    return false;
  }
}

/** Invalidate the cached gh CLI token (e.g. after the user re-authenticates). */
export async function invalidateLocalGhToken(): Promise<void> {
  const store = await cacheStore<string>("gh-cli-token");
  await store.delete(GH_CLI_TOKEN_KEY);
}

// ─── Status ──────────────────────────────────────────────────────────────────

/**
 * THE health probe for the instance's git identity: is there a credential, HOW
 * was it established, and does GitHub still accept it?
 *
 * All three answers come from one function on purpose. `method` used to be
 * resolved by a second call in one caller and not at all in the others, so the
 * dashboard labelled every identity "gh CLI"; and a failed verify collapsed to
 * a bare `available: false`, indistinguishable from "never connected" — the UI
 * silently offered the connect chooser again while a revoked token sat in the
 * DB and kept being handed to clones.
 *
 * Returns { available: false } immediately in cloud modes (app / oauth).
 *
 * NOTE the deliberate asymmetry with `getLocalGhToken()`: this verifies against
 * GitHub, the token getter does not. Resolution stays a cheap DB/cache read on
 * the deploy hot path; the cost of that is a revoked credential surfacing as a
 * clone failure, which is why `problem` exists here for the UI to warn on.
 */
export type LocalGhStatus =
  | {
      available: true;
      login: string;
      id: number;
      avatar_url: string;
      method: GitIdentityMethod;
      /** ISO timestamp of THIS verify, so the UI can say when it last checked. */
      checkedAt: string;
    }
  | {
      available: false;
      /** Non-null only when a credential exists but didn't pass. */
      method: GitIdentityMethod | null;
      problem?: GitIdentityProblem;
      /** Absent when no verify was attempted (there was no credential to verify). */
      checkedAt?: string;
    };

export async function getLocalGhStatus(): Promise<LocalGhStatus> {
  const checkedAt = new Date().toISOString();
  const none = { available: false, method: null, checkedAt } as const;

  // HARD multi-tenant floor (see getLocalGhToken) — never probe gh on the SaaS.
  if (env.CLOUD_MODE) return none;

  const mode = getGitHubAuthMode();
  if (mode === "app" || mode === "oauth") return none;

  const token = await getLocalGhToken();
  if (!token) return none;

  // The credential exists, so from here on every return carries the method —
  // a warning the operator can act on has to name what is broken.
  const method = (await getGitIdentityMethod().catch(() => null)) ?? "host-cli";

  try {
    const res = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (!res.ok) {
      systemDebug(
        "gh-cli",
        `/user verify failed: status=${res.status} method=${method} — the stored GitHub ` +
          `credential was rejected. Reconnect in Settings, or run \`gh auth refresh\`.`,
      );
      // 401/403 is GitHub telling us the credential is bad. Any other status is
      // GitHub having a problem (5xx, rate-limit page, captive proxy) — reporting
      // that as "your token is invalid" would send the operator to revoke a
      // working token.
      const rejected = res.status === 401 || res.status === 403;
      return {
        available: false,
        method,
        problem: rejected ? "rejected" : "unreachable",
        checkedAt,
      };
    }
    const user = (await res.json()) as { login: string; id: number; avatar_url: string };
    return { available: true, ...user, method, checkedAt };
  } catch (err) {
    systemDebug("gh-cli", `/user verify threw: ${safeErrorMessage(err)}`);
    // Network-level failure: never blame the credential.
    return { available: false, method, problem: "unreachable", checkedAt };
  }
}

// ─── Repository listing ─────────────────────────────────────────────────────

/**
 * List the user's repositories via the local gh CLI token.
 *
 * Used in cloud-app mode (self-hosted + cloud-connected) as a SECONDARY
 * source alongside the App installations — surfaces repos the App isn't
 * installed on (personal forks, side-project orgs, etc.) so the user
 * can deploy them as local builds. clone-auth.ts gates the remote-build
 * refusal; this just hands the dashboard a more complete list.
 *
 * Returns [] silently on any failure (no gh, no token, network error).
 * The caller treats this as an optional enhancement.
 */
export async function listLocalGhRepos(_userId: string): Promise<unknown[]> {
  const token = await getLocalGhToken();
  if (!token) return [];

  const data = await ghFetchSoft<unknown[]>(token, {
    url:
      "https://api.github.com/user/repos" +
      "?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member",
  });
  return data ?? [];
}

/**
 * List the gh-CLI user's org memberships with the local gh token —
 * UNGATED, exactly like listLocalGhRepos. The gh-cli home path must NOT
 * route org/repo LISTING through `tokenFor` (which gates the CLI token
 * behind the operator opt-in — that gate exists to stop a non-operator
 * member from shipping the operator's broad token to a REMOTE build, not
 * to block a local read). Listing is a local read, so it uses the token
 * directly via the shared `ghFetchSoft` wire. Returns [] on any failure.
 */
export async function listLocalGhOrgs(
  _userId: string,
): Promise<Array<{ login: string; id: number; avatar_url: string }>> {
  const token = await getLocalGhToken();
  if (!token) return [];

  const data = await ghFetchSoft<Array<{ login: string; id: number; avatar_url: string }>>(token, {
    url: "https://api.github.com/user/orgs?per_page=100",
  });
  return data ?? [];
}

// ─── Internal helpers ────────────────────────────────────────────────────────

/**
 * Candidate absolute paths to try when `gh` isn't found via PATH lookup.
 * The dominant failure: API process is spawned by a tool (bun, electron,
 * launchd) that inherits a stripped PATH missing the user's Homebrew /
 * MacPorts / asdf dirs, so `execFile("gh", …)` returns ENOENT even though
 * `gh` works fine from the user's interactive shell.
 */
const GH_FALLBACK_PATHS = [
  "/opt/homebrew/bin/gh", // Apple Silicon Homebrew
  "/usr/local/bin/gh", // Intel Homebrew + MacPorts
  "/usr/bin/gh", // distro packages on Linux
  "/snap/bin/gh", // Snap-installed gh on Linux
];

/** One-shot exec attempt — resolves to the trimmed stdout on success,
 *  or an error object the caller can log. Used to walk fallback paths
 *  without burying the actual ENOENT/EPERM under a silent null. */
function tryGhExec(bin: string): Promise<{ token: string } | { error: NodeJS.ErrnoException; stderr?: string }> {
  return new Promise((resolve) => {
    execFile(bin, ["auth", "token"], { timeout: 10_000 }, (err, stdout, stderr) => {
      if (err) return resolve({ error: err as NodeJS.ErrnoException, stderr: stderr?.toString() });
      const t = stdout.trim();
      if (!t) {
        return resolve({
          error: Object.assign(new Error("gh auth token returned empty"), { code: "EMPTY" }),
          stderr: stderr?.toString(),
        });
      }
      resolve({ token: t });
    });
  });
}

/**
 * Try `gh auth token`. First attempt uses PATH lookup (`execFile("gh", …)`);
 * on ENOENT we walk a small list of known-install locations so the API
 * process succeeds even when launched with a stripped PATH (bun-dev from a
 * non-login shell, Electron, systemd unit without User=). Every failure
 * is logged so operators can see WHY detection missed — silent null was
 * the worst offender of the previous design.
 */
async function ghAuthTokenViaCli(): Promise<string | null> {
  // Allow operators to bypass PATH guessing entirely.
  const explicit = process.env.GH_BIN;
  const order = explicit ? [explicit] : ["gh", ...GH_FALLBACK_PATHS];

  for (const bin of order) {
    const r = await tryGhExec(bin);
    if ("token" in r) {
      if (bin !== "gh") {
        systemDebug("gh-cli", `resolved via absolute path: ${bin} (PATH lookup failed)`);
      }
      return r.token;
    }
    // ENOENT on the PATH attempt is expected when PATH is stripped — try
    // the next candidate without screaming. For other errors (EPERM,
    // ETIMEDOUT, EMPTY, non-zero exit) log immediately so the operator
    // sees the actual problem.
    const code = r.error.code;
    if (code === "ENOENT") {
      systemDebug("gh-cli", `${bin}: not found`);
      continue;
    }
    // gh exists but the call failed — log and stop. Walking more fallbacks
    // won't help if the same gh binary fails again.
    systemDebug(
      "gh-cli",
      `${bin}: ${code ?? "error"} ${r.error.message}` +
        (r.stderr ? ` stderr=${r.stderr.trim().slice(0, 200)}` : ""),
    );
    return null;
  }
  systemDebug(
    "gh-cli",
    `gh not found via PATH or fallback locations (${GH_FALLBACK_PATHS.join(", ")}). ` +
      `Set GH_BIN=/path/to/gh to override.`,
  );
  return null;
}

/**
 * Read token from the gh CLI config file. Tries (in order):
 *   - $GH_CONFIG_DIR/hosts.yml (explicit override)
 *   - $XDG_CONFIG_HOME/gh/hosts.yml (XDG spec)
 *   - ~/.config/gh/hosts.yml (default)
 *
 * Logs the path it actually attempted on failure so operators can see
 * the resolved location.
 */
async function ghAuthTokenViaConfig(): Promise<string | null> {
  const candidates: string[] = [];
  if (process.env.GH_CONFIG_DIR) candidates.push(join(process.env.GH_CONFIG_DIR, "hosts.yml"));
  if (process.env.XDG_CONFIG_HOME)
    candidates.push(join(process.env.XDG_CONFIG_HOME, "gh", "hosts.yml"));
  candidates.push(join(homedir(), ".config", "gh", "hosts.yml"));

  for (const path of candidates) {
    try {
      const raw = await readFile(path, "utf-8");
      // Simple line-by-line YAML parse — look for `oauth_token:` under `github.com:`
      const ghSection = raw.split(/\n/).reduce<{ inGithub: boolean; token: string | null }>(
        (acc, line) => {
          if (/^github\.com:/i.test(line.trim())) acc.inGithub = true;
          else if (/^\S/.test(line)) acc.inGithub = false;
          if (acc.inGithub) {
            const m = line.match(/^\s+oauth_token:\s*(.+)/);
            if (m && !acc.token) acc.token = m[1].trim();
          }
          return acc;
        },
        { inGithub: false, token: null },
      );
      if (ghSection.token) {
        systemDebug("gh-cli", `resolved token from ${path}`);
        return ghSection.token;
      }
      systemDebug("gh-cli", `${path}: parsed but no oauth_token for github.com`);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        systemDebug("gh-cli", `${path}: ${code ?? "read error"}`);
      }
    }
  }
  return null;
}

// ─── OAuth Device Flow ───────────────────────────────────────────────────────

export interface Verification {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

interface DeviceFlowState {
  status: "pending" | "waiting" | "complete" | "error";
  verification: Verification | null;
  token: string | null;
  error: string | null;
}

/** Active device flows keyed by userId. Only one per user at a time. */
const activeFlows = new Map<string, DeviceFlowState>();

/**
 * Openship's own OAuth app client id for the device flow — the shipped default
 * so a fresh self-hosted instance can sign in to GitHub from the UI with NO
 * setup: no app registration, no cloud account, no SSH into the box.
 *
 * Safe to ship in the open. The device flow exchanges a user-approved code for a
 * token and never sends a client secret (that's the whole point of the grant), so
 * this id grants nothing on its own — same reason `gh` can bake its own id into a
 * public binary.
 *
 * EMPTY means "not provisioned yet": `resolveDeviceClientId` then returns null and
 * the caller falls back to the `gh auth login` terminal instruction, exactly as
 * before. To turn the in-UI flow on for everyone, register an OAuth app with
 * "Enable Device Flow" checked and paste its client id here (operators can
 * override per-instance with GITHUB_DEVICE_CLIENT_ID meanwhile).
 */
const DEVICE_FLOW_CLIENT_ID = "";

/**
 * The client id to run a device flow with, or null when none is available.
 *
 * Priority, most specific first:
 *   1. GITHUB_DEVICE_CLIENT_ID — declared FOR the device flow. Wins because it is
 *      the only one of the three whose purpose is unambiguous.
 *   2. GITHUB_CLIENT_ID        — the operator's OAuth app. DUAL-PURPOSE: `auth.ts`
 *      also uses it (with GITHUB_CLIENT_SECRET) for GitHub social login. It is a
 *      fallback, not the default, precisely because "I set up GitHub sign-in for
 *      my users" must not silently decide which app the device flow authorizes
 *      under — and an app without "Enable Device Flow" ticked fails here with
 *      GitHub's opaque error while an explicit override sat ignored.
 *   3. Openship's shipped id.
 *
 * SaaS never reaches this: `deviceFlowAvailable()` returns false under CLOUD_MODE
 * and `runDeviceFlow` throws there before touching any of it, so the platform's
 * own GITHUB_CLIENT_ID/SECRET can't leak into a device grant. The secret is never
 * read here at all — the device grant has no client-secret step.
 */
export function resolveDeviceClientId(): string | null {
  return (
    env.GITHUB_DEVICE_CLIENT_ID?.trim() ||
    env.GITHUB_CLIENT_ID?.trim() ||
    DEVICE_FLOW_CLIENT_ID.trim() ||
    null
  );
}

/** Can the browser device flow run at all? Drives which flow the API offers. */
export function deviceFlowAvailable(): boolean {
  if (env.CLOUD_MODE) return false;
  const mode = getGitHubAuthMode();
  if (mode === "app" || mode === "oauth") return false;
  return resolveDeviceClientId() !== null;
}

/**
 * Start a GitHub OAuth device flow for a user.
 *
 * Returns the verification info (user_code, verification_uri) that the
 * frontend should display. The flow polls GitHub in the background - use
 * `getDeviceFlowStatus()` to check when the user has completed auth.
 *
 * Requires `GITHUB_CLIENT_ID` in env. No-op in cloud modes.
 */
/**
 * Core GitHub OAuth device-flow engine. Keyed by an arbitrary `flowKey` so it
 * serves both the API-host gh-cli login (`flowKey = userId`) and per-server
 * logins (`flowKey = "server:<id>"`). On completion it invokes `onComplete`
 * with the token — the ONLY difference between the two callers (gh-cli caches
 * it locally; a server login stores it encrypted per-server). One engine, no
 * duplicated octokit wiring.
 */
async function runDeviceFlow(
  flowKey: string,
  onComplete: (token: string) => Promise<void> | void,
): Promise<Verification> {
  // HARD multi-tenant floor (see getLocalGhToken) — device flow logs the
  // SaaS host's gh CLI in, which must never happen.
  if (env.CLOUD_MODE) {
    throw new Error("Device flow is not available in cloud mode");
  }

  const mode = getGitHubAuthMode();
  if (mode === "app" || mode === "oauth") {
    throw new Error("Device flow is not available in cloud/oauth mode");
  }

  const clientId = resolveDeviceClientId();
  if (!clientId) {
    throw new Error(
      "No GitHub client id available for the device flow. Set GITHUB_DEVICE_CLIENT_ID " +
        "(or GITHUB_CLIENT_ID) to an OAuth app with device flow enabled.",
    );
  }

  // Cancel any existing flow for this key
  activeFlows.delete(flowKey);

  const state: DeviceFlowState = {
    status: "pending",
    verification: null,
    token: null,
    error: null,
  };
  activeFlows.set(flowKey, state);

  return new Promise<Verification>((resolveVerification, rejectVerification) => {
    const auth = createOAuthDeviceAuth({
      clientId,
      clientType: "oauth-app",
      scopes: ["repo", "read:org", "read:user"],
      onVerification: (verification) => {
        state.status = "waiting";
        state.verification = verification;
        resolveVerification(verification);
      },
    });

    // Start polling in background - resolves when user completes auth
    auth({ type: "oauth" })
      .then(async (result) => {
        state.status = "complete";
        state.token = result.token;
        await onComplete(result.token);
      })
      .catch((err: Error) => {
        state.status = "error";
        state.error = err.message;
        // If onVerification never fired, reject the start promise
        if (!state.verification) {
          rejectVerification(err);
        }
      });
  });
}

/**
 * Start a GitHub OAuth device flow for the API-host operator. The resulting
 * token is cached into the gh-cli token store so `getLocalGhToken()` picks it
 * up. Requires `GITHUB_CLIENT_ID`. No-op in cloud modes.
 */
export async function startDeviceFlow(userId: string): Promise<Verification> {
  // Persist, don't just cache. See setStoredDeviceToken / the schema note on
  // instance_settings.ghDeviceTokenEncrypted: a cache-only token expired after 8
  // hours into fallbacks that don't exist in a container, silently signing the
  // operator out of a login they completed in the browser.
  return runDeviceFlow(userId, (token) => setStoredDeviceToken(token));
}

/**
 * Start a device flow for a specific SERVER. Same engine as the operator flow,
 * but the completed token is handed to `onComplete` (which stores it encrypted
 * per-server) instead of the gh-cli cache. Poll via `getDeviceFlowStatus` and
 * cancel via `cancelDeviceFlow` using the same `flowKey`.
 */
export async function startServerDeviceFlow(
  flowKey: string,
  onComplete: (token: string) => Promise<void> | void,
): Promise<Verification> {
  return runDeviceFlow(flowKey, onComplete);
}

/**
 * Check the status of an active device flow for a user.
 * Returns null if no flow exists.
 */
export function getDeviceFlowStatus(userId: string): {
  status: "waiting" | "complete" | "error";
  token?: string;
  error?: string;
} | null {
  const state = activeFlows.get(userId);
  if (!state || state.status === "pending") return null;

  const result: { status: "waiting" | "complete" | "error"; token?: string; error?: string } = {
    status: state.status,
  };

  if (state.status === "complete" && state.token) {
    result.token = state.token;
    // Clean up after the token has been retrieved
    activeFlows.delete(userId);
  }
  if (state.status === "error") {
    result.error = state.error ?? "Unknown error";
    activeFlows.delete(userId);
  }

  return result;
}

/**
 * Cancel an active device flow for a user.
 */
export function cancelDeviceFlow(userId: string): void {
  activeFlows.delete(userId);
}
