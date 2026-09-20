import { connect } from "node:net";
import { request } from "node:http";

/**
 * Why a TCP dial failed, as far as a socket can tell.
 *
 * The distinction IS the diagnosis. A dropped SYN produces nothing to receive, so
 * the dial can only time out — the signature of a default-deny packet filter. An RST
 * means the packet arrived somewhere and was rejected. A name that never resolved
 * never left the box at all. Collapsing these into one boolean is how a blocked
 * container→host channel came to be prescribed a firewall rule whatever the actual
 * fault was (#490), including for rootless Docker, where the host gateway simply
 * doesn't exist (#482).
 */
export type TcpProbeFailure =
  /** Nothing came back before the deadline: dropped, or the host is gone. */
  | "timeout"
  /** RST — something answered and refused. Nothing listening, or a REJECT rule. */
  | "refused"
  /** The hostname didn't resolve on this side. */
  | "unresolved"
  /** The kernel had no route to the address. */
  | "no_route"
  /** Anything else; `code`/`message` carry what we were told. */
  | "error";

export type TcpProbeResult =
  | { ok: true }
  | { ok: false; reason: TcpProbeFailure; code?: string; message?: string };

function classifyDialError(code: string | undefined): TcpProbeFailure {
  switch (code) {
    case "ECONNREFUSED":
    case "ECONNRESET":
      return "refused";
    case "ENOTFOUND":
    case "EAI_AGAIN":
      return "unresolved";
    case "EHOSTUNREACH":
    case "ENETUNREACH":
    case "ENETDOWN":
      return "no_route";
    // The kernel's own connect timeout, i.e. our `timeout` reported for us.
    case "ETIMEDOUT":
      return "timeout";
    default:
      return "error";
  }
}

/**
 * TCP liveness probe that reports HOW it failed. See {@link TcpProbeFailure} for why
 * that matters. Never throws; always tears the socket down.
 *
 * Deliberately independent of the SSH executor (system-ssh agent vs in-process ssh2)
 * — a TCP handshake to the SSH port is the fastest way to decide "is this host
 * answering?" without paying the 15-20s SSH connect timeout that hangs the
 * delete/reconcile paths when a server is down.
 */
export function probeTcpDetailed(
  host: string,
  port: number,
  timeoutMs = 2500,
): Promise<TcpProbeResult> {
  return new Promise<TcpProbeResult>((resolve) => {
    let settled = false;
    const done = (result: TcpProbeResult, socket?: ReturnType<typeof connect>) => {
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
    socket.once("connect", () => done({ ok: true }, socket));
    socket.once("timeout", () =>
      done({ ok: false, reason: "timeout", message: `no response within ${timeoutMs}ms` }, socket),
    );
    socket.once("error", (err: Error) => {
      const errno = err as NodeJS.ErrnoException;
      done(
        {
          ok: false,
          reason: classifyDialError(errno.code),
          ...(errno.code ? { code: errno.code } : {}),
          ...(errno.message ? { message: errno.message } : {}),
        },
        socket,
      );
    });
  });
}

/**
 * Is `host:port` accepting connections within `timeoutMs`? `false` for every failure
 * mode; never throws. Callers that need to tell those modes apart — and so must not
 * flatten them — want {@link probeTcpDetailed}.
 */
export async function probeTcp(host: string, port: number, timeoutMs = 2500): Promise<boolean> {
  return (await probeTcpDetailed(host, port, timeoutMs)).ok;
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

/**
 * One HTTP GET to the local edge, asked AS a specific hostname.
 *
 * Separate from `probeHttp` for two reasons, both essential to a static route
 * check: it sets an explicit `Host:` header (the edge picks its server block by
 * that header, so without it every request lands on `default_server` and the
 * answer says nothing about the route), and it returns the STATUS rather than a
 * boolean, because 404 vs 403 vs 502 are three different diagnoses.
 *
 * Returns `null` when nothing answered — a connection error or a timeout is "no
 * signal about this path", never "the path is broken".
 */
export function probeHostedHttp(opts: {
  hostname: string;
  path?: string;
  port?: number;
  timeoutMs?: number;
}): Promise<{ status: number; served: boolean } | null> {
  const { hostname, path = "/", port = 80, timeoutMs = 3000 } = opts;
  return new Promise((resolve) => {
    let settled = false;
    const done = (value: { status: number; served: boolean } | null) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: "GET",
        timeout: timeoutMs,
        // Claim https so the :80 block SERVES instead of answering our own
        // HTTP→HTTPS redirect before the doc root is consulted — see the curl twin in
        // output-exists.ts for why a 301 here read as a healthy site.
        headers: { Host: hostname, "X-Forwarded-Proto": "https" },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        res.resume(); // drain so the socket can close
        // 401/403 mean a POLICY answered — basic auth, an edge rules guard. The
        // route resolved and the files were found, so this counts as served; only
        // 404 and 5xx are the failure signals. Mirrors `statusIsServed` in
        // output-exists.ts, which answers the same question for the curl path.
        done(
          status > 0
            ? { status, served: (status >= 200 && status < 400) || status === 401 || status === 403 }
            : null,
        );
      },
    );
    const fail = () => {
      try {
        req.destroy();
      } catch {
        /* already torn down */
      }
      done(null);
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
