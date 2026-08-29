/**
 * Loopback control-plane helpers, shared by the interactive install wizard
 * (commands/wizard.ts), the headless installer (lib/instance-provision.ts),
 * `openship up` (commands/up.ts), doctor/repair and reset-admin-password. Single
 * home for the internal-token-gated request + the boot/health polls, so there's
 * exactly ONE copy (no per-command duplication).
 *
 * The API is bound to loopback and gated by X-Internal-Token. WHICH token that is
 * depends on the install method, so it is resolved in one place (lib/internal-token)
 * rather than chosen per call site — the mistake that made every compose box answer
 * "Unauthorized" to `openship reset-admin-password`.
 */

import {
  internalTokenProblem,
  internalTokenRejectedProblem,
  internalTokenSources,
} from "./internal-token";
import { OS_DIR } from "./paths";

/** The CLI's state dir (internal-token, auth-secret, data, logs); ~/.openship
 *  by default, or OPENSHIP_HOME for a from-source install. Re-exported for the
 *  many callers that import it from here. */
export { OS_DIR };

/**
 * The outcome of an internal-token-gated call, as three DIFFERENT facts.
 *
 * Collapsing them is what made a compose box report "Unauthorized" for a token store
 * the invoking user simply couldn't read: no-token (nothing on disk to try, or a
 * root-owned `.env`) is a different operator action than unreachable (wrong port /
 * nothing running) and than a 401 the API actually returned.
 */
export type InternalCall =
  | {
      kind: "response";
      res: Response;
      /** The 401 came from internalAuth, and every token we hold was refused. */
      tokenRejected?: boolean;
    }
  | { kind: "no-token"; detail: string }
  | { kind: "unreachable"; detail: string };

/**
 * Was this 401 the internal-auth middleware refusing the token, or a HANDLER's own?
 *
 * The distinction decides whether the request may be repeated: internalAuth answers
 * before the handler runs, so retrying it with another token repeats nothing — while
 * `/api/system/cloud-connect` answers 401 with "Could not verify with Openship Cloud"
 * AFTER exchanging a single-use PKCE code, where a retry would burn the code and the
 * rewritten message would blame the wrong thing entirely.
 *
 * internalAuth's body is exactly `{"error":"Unauthorized"}` (middleware/internal-auth.ts),
 * so that is the only shape treated as a token rejection. Anything else — including a
 * body we can't parse — is passed through as-is, which is what the CLI did before it
 * knew about candidates: no retry, no rewording, the API's own answer.
 */
function isInternalAuthRejection(body: string): boolean {
  try {
    return (JSON.parse(body) as { error?: unknown }).error === "Unauthorized";
  } catch {
    return false;
  }
}

/** Re-wrap a response whose body we had to read in order to classify it, so the caller
 *  can still consume it normally. */
function replay(res: Response, body: string): Response {
  return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
}

/**
 * The one internal-token-gated request path.
 *
 * `token` is for callers that KNOW which api they're addressing — the compose
 * provisioning flows, which hold the token they just wrote. Everyone else omits it and
 * gets `internalTokenSources()`: every token this box legitimately holds, tried in
 * evidence order. Never mints: see lib/internal-token.
 *
 * Only a 401 from internalAuth is retried (see isInternalAuthRejection), and only that
 * path reads the body — a streaming caller's response is handed back untouched, so the
 * self-register SSE stream still arrives frame by frame.
 */
export async function internalFetch(
  port: string,
  path: string,
  init: RequestInit = {},
  token?: string,
): Promise<InternalCall> {
  const candidates = token ? [token] : internalTokenSources().tokens;
  if (candidates.length === 0) return { kind: "no-token", detail: internalTokenProblem() };

  const url = `http://127.0.0.1:${port}${path}`;
  let refused: Response | undefined;
  for (const candidate of candidates) {
    let res: Response;
    try {
      res = await fetch(url, {
        ...init,
        headers: {
          ...(init.headers as Record<string, string> | undefined),
          "X-Internal-Token": candidate,
        },
      });
    } catch (err) {
      return { kind: "unreachable", detail: (err as Error).message };
    }
    if (res.status !== 401) return { kind: "response", res };
    const body = await res.text().catch(() => "");
    if (!isInternalAuthRejection(body)) return { kind: "response", res: replay(res, body) };
    refused = replay(res, body);
  }
  // Every token we hold was refused — hand the last 401 back readable, flagged, so the
  // caller can say WHICH kind of failure this is (internalTokenRejectedProblem).
  return { kind: "response", res: refused!, tokenRejected: true };
}

/** Why a 401 came back after every candidate was tried. Re-exported so callers don't
 *  each import the token module just to phrase this. */
export { internalTokenRejectedProblem };

export async function internalGet(port: string, path: string, token?: string): Promise<any | null> {
  const call = await internalFetch(
    port,
    path,
    { signal: AbortSignal.timeout(10000) },
    token,
  );
  if (call.kind !== "response" || !call.res.ok) return null;
  return await call.res.json().catch(() => null);
}

export async function internalPost(
  port: string,
  path: string,
  body: unknown,
  token?: string,
): Promise<{ ok: boolean; data: any }> {
  const call = await internalFetch(
    port,
    path,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    },
    token,
  );
  // A token problem is reported as the error TEXT rather than a bare "failed": every
  // caller of this prints `data.error`, so the fix (sudo, `openship up`, a port) lands
  // in front of the operator instead of a generic Unauthorized.
  if (call.kind !== "response") return { ok: false, data: { error: call.detail } };
  const data = (await call.res.json().catch(() => ({}))) as Record<string, unknown>;
  // Keyed off the flag, not the status: a handler's own 401 keeps its message.
  if (call.tokenRejected && !token) {
    return { ok: false, data: { ...data, error: internalTokenRejectedProblem() } };
  }
  return { ok: call.res.ok, data };
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
