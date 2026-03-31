import type { SystemSettings, TunnelConfig, SetupPayload } from "./types";

type FetchFn = typeof globalThis.fetch;

export interface SetupClientOptions {
  /** Base URL of the API (e.g. "http://localhost:4000") */
  apiUrl: string;
  /** Internal auth token passed via X-Internal-Token header */
  internalToken?: string;
  /** Optional fetch implementation (defaults to globalThis.fetch) */
  fetch?: FetchFn;
}

function getFetch(opts: SetupClientOptions): FetchFn {
  return opts.fetch ?? globalThis.fetch;
}

function headers(opts: SetupClientOptions): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.internalToken) h["X-Internal-Token"] = opts.internalToken;
  return h;
}

/**
 * Build the JSON payload for POST /api/system/setup from structured inputs.
 */
export function buildSetupPayload(settings: {
  system?: SystemSettings;
  tunnel?: TunnelConfig;
  buildMode?: string;
  authMode?: string;
}): SetupPayload {
  const payload: SetupPayload = {
    defaultBuildMode: settings.buildMode || "auto",
    authMode: settings.authMode || "none",
  };

  if (settings.system) {
    const s = settings.system;
    payload.serverName = s.serverName ?? null;
    payload.sshHost = s.sshHost;
    payload.sshPort = s.sshPort ?? 22;
    payload.sshUser = s.sshUser ?? "root";
    payload.sshAuthMethod = s.sshAuthMethod;
    if (s.sshPassword) payload.sshPassword = s.sshPassword;
    if (s.sshKeyPath) payload.sshKeyPath = s.sshKeyPath;
    if (s.sshKeyPassphrase) payload.sshKeyPassphrase = s.sshKeyPassphrase;
    if (s.sshJumpHost) payload.sshJumpHost = s.sshJumpHost;
    if (s.sshArgs) payload.sshArgs = s.sshArgs;
  }

  if (settings.tunnel) {
    payload.tunnelProvider = settings.tunnel.provider;
    if (settings.tunnel.token) payload.tunnelToken = settings.tunnel.token;
  }

  return payload;
}

/**
 * Push instance settings to POST /api/system/setup.
 * Does not throw — logs and returns false on failure.
 */
export async function pushInstanceSettings(
  opts: SetupClientOptions,
  settings: {
    system?: SystemSettings;
    tunnel?: TunnelConfig;
    buildMode?: string;
    authMode?: string;
  },
): Promise<boolean> {
  const fetchFn = getFetch(opts);
  const payload = buildSetupPayload(settings);
  try {
    const res = await fetchFn(`${opts.apiUrl}/api/system/setup`, {
      method: "POST",
      headers: headers(opts),
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Poll the API health endpoint until it responds OK.
 * Returns true when ready, false if it never becomes ready.
 */
export async function waitForApi(
  opts: SetupClientOptions,
  maxAttempts = 30,
  intervalMs = 1000,
): Promise<boolean> {
  const fetchFn = getFetch(opts);
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const res = await fetchFn(`${opts.apiUrl}/api/health`, {
        signal: AbortSignal.timeout(2000),
      });
      if (res.ok) return true;
    } catch {
      // Not ready yet
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}
