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
import { env } from "../../config/env";
import { cacheStore } from "../../lib/cache-store";
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

  let token = await ghAuthTokenViaCli();
  if (!token) token = await ghAuthTokenViaConfig();
  if (token) await store.set(GH_CLI_TOKEN_KEY, token, GH_CLI_TOKEN_TTL_S);
  return token;
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
 * Check whether the machine has a valid `gh` CLI token and return the
 * associated GitHub user profile.
 * Returns { available: false } immediately in cloud modes (app / oauth).
 */
export async function getLocalGhStatus(): Promise<
  | { available: true; login: string; id: number; avatar_url: string }
  | { available: false }
> {
  // HARD multi-tenant floor (see getLocalGhToken) — never probe gh on the SaaS.
  if (env.CLOUD_MODE) return { available: false };

  const mode = getGitHubAuthMode();
  if (mode === "app" || mode === "oauth") return { available: false };

  const token = await getLocalGhToken();
  if (!token) return { available: false };

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
        `/user verify failed: status=${res.status} — token from gh CLI was rejected. Run \`gh auth refresh\` or \`gh auth login\`.`,
      );
      return { available: false };
    }
    const user = (await res.json()) as { login: string; id: number; avatar_url: string };
    return { available: true, ...user };
  } catch (err) {
    systemDebug(
      "gh-cli",
      `/user verify threw: ${safeErrorMessage(err)}`,
    );
    return { available: false };
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

  const clientId = env.GITHUB_CLIENT_ID;
  if (!clientId) {
    throw new Error("GITHUB_CLIENT_ID is required for the device flow");
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
  return runDeviceFlow(userId, async (token) => {
    const store = await cacheStore<string>("gh-cli-token");
    await store.set(GH_CLI_TOKEN_KEY, token, 8 * 60 * 60);
  });
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
