/**
 * GitHub local auth — resolves GitHub credentials from the machine's `gh` CLI.
 *
 * Used in local / desktop mode where there is no GitHub App and no OAuth
 * callback. Users authenticate via `gh auth login` on their machine and
 * we piggyback on that token.
 *
 * Resolution order:
 *   1. `gh auth token` subprocess (works on any OS where `gh` is in PATH)
 *   2. Read `~/.config/gh/hosts.yml` directly (fallback when `gh` binary is missing)
 *
 * This module also exposes `getLocalGhStatus()` — a convenience that validates
 * the resolved token against the GitHub API and returns the user profile.
 *
 * SAFETY: All functions check `getGitHubAuthMode()` (the single source of
 * truth from github.auth) and are no-ops when mode is "app" or "oauth" —
 * prevents subprocess execution and filesystem reads on cloud servers.
 */

import { execFile } from "child_process";
import { readFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";
import { createOAuthDeviceAuth } from "@octokit/auth-oauth-device";
import { env } from "../../config/env";
import { TtlCache } from "../../lib/cache";
import { getGitHubAuthMode } from "./github.auth";

// ─── Cache ───────────────────────────────────────────────────────────────────

const cache = new TtlCache<string>({ maxSize: 100, sweepIntervalMs: 60_000 });

// ─── Token resolution ────────────────────────────────────────────────────────

/**
 * Resolve the GitHub token from the local `gh` CLI.
 * Result is cached for 5 minutes to avoid shelling out on every request.
 * Returns null immediately in cloud modes (app / oauth).
 */
export async function getLocalGhToken(): Promise<string | null> {
  const mode = getGitHubAuthMode();
  if (mode === "app" || mode === "oauth") return null;

  const cacheKey = "local:gh-cli-token";
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  let token = await ghAuthTokenViaCli();
  if (!token) {
    token = await ghAuthTokenViaConfig();
  }
  if (token) {
    cache.set(cacheKey, token, 5 * 60);
  }
  return token;
}

/**
 * Invalidate the cached gh CLI token (e.g. after the user re-authenticates).
 */
export function invalidateLocalGhToken(): void {
  cache.invalidateBySubstring("local:gh-cli-token");
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
    if (!res.ok) return { available: false };
    const user = (await res.json()) as { login: string; id: number; avatar_url: string };
    return { available: true, ...user };
  } catch {
    return { available: false };
  }
}

// ─── Internal helpers ────────────────────────────────────────────────────────

/** Try `gh auth token` subprocess. */
function ghAuthTokenViaCli(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("gh", ["auth", "token"], { timeout: 5_000 }, (err, stdout) => {
      if (err || !stdout) return resolve(null);
      const t = stdout.trim();
      resolve(t || null);
    });
  });
}

/** Read token from the gh CLI config file (`~/.config/gh/hosts.yml`). */
async function ghAuthTokenViaConfig(): Promise<string | null> {
  try {
    const configDir = process.env.GH_CONFIG_DIR || join(homedir(), ".config", "gh");
    const raw = await readFile(join(configDir, "hosts.yml"), "utf-8");
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
    return ghSection.token || null;
  } catch {
    return null;
  }
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
 * frontend should display. The flow polls GitHub in the background — use
 * `getDeviceFlowStatus()` to check when the user has completed auth.
 *
 * Requires `GITHUB_CLIENT_ID` in env. No-op in cloud modes.
 */
export async function startDeviceFlow(userId: string): Promise<Verification> {
  const mode = getGitHubAuthMode();
  if (mode === "app" || mode === "oauth") {
    throw new Error("Device flow is not available in cloud/oauth mode");
  }

  const clientId = env.GITHUB_CLIENT_ID;
  if (!clientId) {
    throw new Error("GITHUB_CLIENT_ID is required for the device flow");
  }

  // Cancel any existing flow for this user
  activeFlows.delete(userId);

  const state: DeviceFlowState = {
    status: "pending",
    verification: null,
    token: null,
    error: null,
  };
  activeFlows.set(userId, state);

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

    // Start polling in background — resolves when user completes auth
    auth({ type: "oauth" })
      .then((result) => {
        state.status = "complete";
        state.token = result.token;
        // Cache the token so resolveToken() picks it up
        cache.set("local:gh-cli-token", result.token, 8 * 60 * 60);
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
