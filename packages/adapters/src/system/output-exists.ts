/**
 * "Does this static route actually serve?" probe, answered from the EDGE's own
 * vantage point.
 *
 * Two halves, one exec:
 *   - FILESYSTEM — does the served path exist, and is something servable there?
 *     Mirrors port-listen.ts: runs where the files live (inside the edge
 *     container, or on the host for a bare edge).
 *   - HTTP — does a real request to the edge for that hostname and path come back
 *     with a non-error status? This is the half a filesystem check structurally
 *     cannot answer: correct files with unreadable modes, a vhost that was never
 *     written, a root the edge container cannot see. A static site's ONLY failure
 *     mode is a 404, so the probe that predicts it has to be an actual request.
 *
 * Advisory by contract. Every field distinguishes "we looked and it's broken"
 * from "we could not look": `checked:false` for the filesystem half, and an
 * ABSENT `served`/`status` for the HTTP half. A caller that reads `!served`
 * instead of `served === false` turns "no signal" into a false alarm.
 */

import type { PortProbeExecutor } from "./port-listen";

export interface OutputProbeResult {
  /** The served path exists (a file or a directory). */
  found: boolean;
  /** Something servable is there: the path IS a file, or it's a dir with index.html. */
  hasIndex: boolean;
  /**
   * The probe ran and produced a reading. False = inconclusive (executor
   * unusable) — callers must treat `checked:false` as "no signal", never as
   * "missing".
   */
  checked: boolean;
  /**
   * HTTP status the edge answered for this hostname + path. ABSENT means no HTTP
   * signal at all (no hostname to ask as, no curl, or nothing accepted the
   * connection) — never "0" and never an error.
   */
  status?: number;
  /**
   * The edge answered and the answer was not a failure. ABSENT = no signal;
   * read it as `served === false` to mean "proven broken".
   */
  served?: boolean;
}

export interface StaticProbeOptions {
  /** `Host:` header to ask as. Omit to skip the HTTP half entirely. */
  hostname?: string;
  /** Routed path to request. Defaults to "/". */
  requestPath?: string;
  /** Port the edge serves plain HTTP on. Defaults to 80. */
  edgePort?: number;
  /** curl's --max-time, in seconds. Defaults to 3 — it has to fit inside the
   *  on-demand check's overall budget. */
  timeoutSeconds?: number;
}

/**
 * A hostname and a path safe to interpolate into a shell command.
 *
 * Both values are already sanitized upstream (`assertValidDomain` before a vhost
 * is written, `normalizeTargetPath` for the route), so this is defence in depth at
 * the point of use. A value that fails simply DROPS the HTTP half — no signal is
 * always a safe answer, and it is never worth risking an injection to get one.
 */
const SAFE_HOST = /^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/;
const SAFE_PATH = /^\/[A-Za-z0-9._~/-]*$/;

/** A routed path we are willing to request. Traversal is rejected separately from
 *  the character class because `.` is legitimate in a path segment (`/v1.2/`) —
 *  and a `..` is not a shell risk here (the URL is single-quoted) but WOULD probe
 *  a different path than the route, which is a wrong answer rather than no answer. */
function safeRequestPath(path: string): boolean {
  return SAFE_PATH.test(path) && !path.split("/").includes("..");
}

/** Print explicit tokens and force exit 0 so a missing path or a failed request
 *  never rejects the exec (same discipline as PROC_NET_TCP_CMD). */
function buildCommand(servedPath: string, opts?: StaticProbeOptions): string {
  const p = servedPath.replace(/'/g, "'\\''");
  const parts = [
    `if [ -e '${p}' ]; then echo FOUND; fi`,
    `if [ -f '${p}' ] || [ -f '${p}/index.html' ]; then echo INDEX; fi`,
  ];

  const host = opts?.hostname;
  const path = opts?.requestPath ?? "/";
  if (host && SAFE_HOST.test(host) && safeRequestPath(path)) {
    const port = opts?.edgePort ?? 80;
    const maxTime = opts?.timeoutSeconds ?? 3;
    // `%{num_connects}` is the TCP verdict and curl's exit code is NOT: curl exits
    // 28 for a timeout both before AND after connecting, so a dropped SYN and a
    // slow-but-answering edge are indistinguishable by status alone. 0 connects
    // means we learned nothing about the path.
    // `X-Forwarded-Proto: https` is what makes this probe exercise the SERVE path
    // instead of the redirect. On a route with a real certificate the :80 block opens
    // with HTTPS_UPGRADE — `if ($openship_redirect_https) { return 301 … }` — and
    // `$openship_redirect_https` is 1 unless the request claims https (FORWARD_VARS
    // in infra/nginx.ts). So a plain `Host:`-only request was answered 301 without
    // the doc root ever being touched, `statusIsServed` mapped 3xx to served, and
    // `outputFindingIsBroken` let that override the correct `!hasIndex` verdict: a
    // wrong Output Directory deployed green and 404'd every real visitor.
    //
    // Spoofable, and harmlessly so — this is a loopback request we make to ourselves,
    // and the header's only effect is skipping our own redirect.
    parts.push(
      `if command -v curl >/dev/null 2>&1; then ` +
        `echo "HTTP $(curl -sS -o /dev/null -w '%{http_code} %{num_connects}' ` +
        `--max-time ${maxTime} -H 'Host: ${host}' -H 'X-Forwarded-Proto: https' ` +
        `'http://127.0.0.1:${port}${path}' 2>/dev/null)"; fi`,
    );
  }

  parts.push("true");
  return parts.join("; ");
}

/**
 * A status the edge produced by RESOLVING the route, even though it isn't a 2xx.
 *
 * 401/403 mean a policy answered — basic auth, an edge rules guard, a geo rule.
 * The files were found and the vhost works; treating those as "does not serve"
 * would veto a deploy that is behaving exactly as configured. 404 and 5xx are the
 * real signals.
 */
function statusIsServed(status: number): boolean {
  if (status >= 200 && status < 400) return true;
  return status === 401 || status === 403;
}

function parseHttp(out: string): { status?: number; served?: boolean } {
  const match = /(^|\n)HTTP (\d+) (\d+)(\r?\n|$)/.exec(out);
  if (!match) return {};
  const status = Number(match[2]);
  const connects = Number(match[3]);
  // Nothing accepted a connection, or a non-HTTP answer: no signal about the path.
  if (!Number.isFinite(status) || status === 0 || connects === 0) return {};
  return { status, served: statusIsServed(status) };
}

/**
 * One probe. Never throws — returns `checked:false` when the exec itself failed
 * (inconclusive). No polling: static output is written before a deploy reports
 * "started", so unlike a port there's nothing to wait for.
 */
export async function probeStaticOutput(
  executor: PortProbeExecutor,
  servedPath: string,
  opts?: StaticProbeOptions,
): Promise<OutputProbeResult> {
  try {
    const out = await executor.exec(buildCommand(servedPath, opts), { timeout: 8_000 });
    return {
      found: /(^|\n)FOUND(\r?\n|$)/.test(out),
      hasIndex: /(^|\n)INDEX(\r?\n|$)/.test(out),
      checked: true,
      ...parseHttp(out),
    };
  } catch {
    return { found: false, hasIndex: false, checked: false };
  }
}

/** Exported for the command/parse unit tests — the shell text and the marker
 *  parsing are the whole contract, and they are testable without a daemon. */
export const __staticProbeInternals = { buildCommand, parseHttp, statusIsServed };
