import { connect } from "node:net";
import { request } from "node:http";

/**
 * Cheap TCP liveness probe. Opens a raw socket to `host:port` and resolves
 * `true` if the connection is accepted within `timeoutMs`, `false` otherwise
 * (connection refused, host unreachable, timeout, DNS failure). Never throws;
 * always tears the socket down.
 *
 * This is deliberately independent of the SSH executor (system-ssh agent vs
 * in-process ssh2) — a TCP handshake to the SSH port is the fastest way to
 * decide "is this host answering?" without paying the 15-20s SSH connect
 * timeout that hangs the delete/reconcile paths when a server is down.
 */
export function probeTcp(host: string, port: number, timeoutMs = 2500): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const done = (result: boolean, socket?: ReturnType<typeof connect>) => {
      if (settled) return;
      settled = true;
      try {
        socket?.destroy();
      } catch {
        /* already torn down */
      }
      resolve(result);
    };

    const socket = connect({ host, port });
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true, socket));
    socket.once("timeout", () => done(false, socket));
    socket.once("error", () => done(false, socket));
  });
}

/**
 * One HTTP GET. Resolves `true` when the server answers with a status the
 * caller accepts (default: any 1xx-4xx, i.e. < 500 — "the app is serving, even
 * if this path 404s"). Resolves `false` on connection error/timeout or a 5xx.
 * Never throws.
 */
export function probeHttp(
  host: string,
  port: number,
  path = "/",
  timeoutMs = 2500,
  acceptStatusBelow = 500,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const req = request({ host, port, path, method: "GET", timeout: timeoutMs }, (res) => {
      const status = res.statusCode ?? 0;
      res.resume(); // drain so the socket can close
      if (!settled) {
        settled = true;
        resolve(status > 0 && status < acceptStatusBelow);
      }
    });
    const fail = () => {
      if (settled) return;
      settled = true;
      try {
        req.destroy();
      } catch {
        /* already torn down */
      }
      resolve(false);
    };
    req.once("timeout", fail);
    req.once("error", fail);
    req.end();
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Poll a host:port until it is ready or the deadline passes.
 *
 * "Ready" means a TCP connection is accepted; if `path` is given it additionally
 * requires an HTTP GET to answer below `acceptStatusBelow` (default 500) — so an
 * app that binds its port but 500s is still considered not-ready. Returns `true`
 * on success, `false` on timeout. Never throws.
 *
 * Used as the post-deploy health gate (TCP-only, so non-HTTP services pass) and
 * by the per-stack deploy harness (with `path` to assert the app actually
 * serves). Callers decide whether a `false` result is fatal.
 */
export async function waitForReady(
  host: string,
  port: number,
  opts: {
    path?: string;
    timeoutMs?: number;
    intervalMs?: number;
    probeTimeoutMs?: number;
    acceptStatusBelow?: number;
  } = {},
): Promise<boolean> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const intervalMs = opts.intervalMs ?? 1_000;
  const probeTimeoutMs = opts.probeTimeoutMs ?? 2_500;
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    if (await probeTcp(host, port, probeTimeoutMs)) {
      if (!opts.path) return true;
      if (await probeHttp(host, port, opts.path, probeTimeoutMs, opts.acceptStatusBelow ?? 500)) {
        return true;
      }
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    await delay(Math.min(intervalMs, remaining));
  }
}
