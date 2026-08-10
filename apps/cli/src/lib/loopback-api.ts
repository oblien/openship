/**
 * Loopback control-plane helpers, shared by the interactive install wizard
 * (commands/wizard.ts), the headless installer (lib/instance-provision.ts), and
 * `openship up` (commands/up.ts). Single home for the internal-token file + the
 * internal-token-gated POST/GET + the boot/health polls, so there's exactly ONE
 * copy (no per-command duplication).
 *
 * The API is bound to loopback and gated by X-Internal-Token; the same token
 * file the API boots with is read here so setup calls (bootstrap-admin,
 * self-register) authenticate without a browser session.
 */

import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

import { INTERNAL_TOKEN_FILE, OS_DIR } from "./paths";

/** The CLI's state dir (internal-token, auth-secret, data, logs); ~/.openship
 *  by default, or OPENSHIP_HOME for a from-source install. Re-exported for the
 *  many callers that import it from here. */
export { OS_DIR };

/**
 * Persist a stable INTERNAL_TOKEN. The API is booted with it (so zero-auth is
 * off), and the setup flows read the SAME file to authenticate their one-shot
 * loopback calls. A browser reaching the API through the public proxy has no
 * token, so it can't create the admin.
 */
export function ensureInternalToken(): string {
  const path = INTERNAL_TOKEN_FILE;
  if (existsSync(path)) return readFileSync(path, "utf8").trim();
  mkdirSync(OS_DIR, { recursive: true, mode: 0o700 });
  const token = randomBytes(32).toString("hex");
  writeFileSync(path, token, { mode: 0o600 });
  return token;
}

// The internal token differs by install method: the bare service reads/writes
// `~/.openship/internal-token` (ensureInternalToken); the Compose stack boots the
// api container with the token from `compose/.env` (composeInternalToken). Callers
// provisioning the Compose stack pass that token explicitly so these loopback
// calls authenticate against the RIGHT api — hence the optional `token` arg.
export async function internalGet(port: string, path: string, token?: string): Promise<any | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      headers: { "X-Internal-Token": token ?? ensureInternalToken() },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export async function internalPost(
  port: string,
  path: string,
  body: unknown,
  token?: string,
): Promise<{ ok: boolean; data: any }> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Internal-Token": token ?? ensureInternalToken() },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, data };
  } catch (err) {
    return { ok: false, data: { error: (err as Error).message } };
  }
}

/** POST the first admin to the internal-token-gated bootstrap endpoint. */
export async function bootstrapAdmin(
  apiPort: string,
  admin: { name: string; email: string; password: string },
  token?: string,
): Promise<{ ok: boolean; message?: string }> {
  const { ok, data } = await internalPost(apiPort, "/api/system/bootstrap-admin", admin, token);
  if (ok) return { ok: true };
  if (data?.error === "An admin account already exists") return { ok: true, message: "already-exists" };
  return { ok: false, message: data?.error || "failed" };
}

export async function waitHealthy(apiPort: string, seconds = 90): Promise<boolean> {
  for (let i = 0; i < seconds; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    try {
      await fetch(`http://127.0.0.1:${apiPort}/api/health`, { signal: AbortSignal.timeout(2000) });
      return true;
    } catch {
      /* not up yet */
    }
  }
  return false;
}

/** Poll the dashboard port until it serves — best-effort (returns false on timeout). */
export async function waitDashboard(dashPort: string, seconds = 45): Promise<boolean> {
  for (let i = 0; i < seconds; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    try {
      const res = await fetch(`http://127.0.0.1:${dashPort}/`, {
        redirect: "manual",
        signal: AbortSignal.timeout(2000),
      });
      if (res.status > 0) return true;
    } catch {
      /* not up yet */
    }
  }
  return false;
}

/** Best-effort public IP for the A-record hint + edge-proxy target. */
export async function detectPublicIp(): Promise<string | null> {
  for (const url of ["https://api.ipify.org", "https://ifconfig.me/ip"]) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (!res.ok) continue;
      const ip = (await res.text()).trim();
      if (/^[0-9.]+$/.test(ip) || ip.includes(":")) return ip;
    } catch {
      /* try next */
    }
  }
  return null;
}
