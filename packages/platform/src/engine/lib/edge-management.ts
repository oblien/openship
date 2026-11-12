/**
 * Shared OpenResty management client for route rules, analytics and live logs.
 * Remote edges use the pooled SSH tunnel; hosts without a usable tunnel run
 * curl inside their edge container, where the management loopback is reachable.
 */

import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import {
  reportCaughtError as observeCaughtError,
  diagnostics as errorDiagnostics,
} from "@repo/core/diagnostics";
import { safeErrorMessage } from "@repo/core";
import { repos } from "@repo/db";
import {
  OPENRESTY_MGMT_PORT,
  containerCommand,
  resolveOurEdgeContainer,
  sq,
  type LogEntry,
} from "@repo/adapters";
import { tunnelRequest, tunnelStream } from "./ssh-tunnel";
import { sshManager } from "./ssh-manager";
import { systemDebug } from "./system-debug";

async function execMgmt(
  serverId: string,
  path: string,
  opts: { method?: string; json?: unknown } = {},
): Promise<{ statusCode: number; body: string } | null> {
  try {
    const executor = await sshManager.acquire(serverId);
    const container = await resolveOurEdgeContainer(executor);
    if (!container) return null;

    const url = `http://127.0.0.1:${OPENRESTY_MGMT_PORT}${path}`;
    // Status to stdout via -w, body to a temp file, emitted as "<status>\n<body>"
    // — status FIRST so a JSON body containing newlines survives intact.
    // --fail-with-body isn't usable: we want the mgmt API's own error body.
    //
    // mktemp, not a fixed path: the scraper issues several of these per tick
    // (totals, then one per domain for geo), and a shared /tmp name would let
    // concurrent calls read each other's bodies. The inner `sh -c` expands "$B";
    // containerCommand owns the outer quoting.
    const payload = opts.json === undefined ? undefined : JSON.stringify(opts.json);
    // JSON always travels as data. This avoids command-size thresholds and
    // nested quoting differences between local, SSH and elevated executors.
    const requestFile =
      payload === undefined ? undefined : `/tmp/openship-edge-request-${randomUUID()}.json`;
    const uploadWithInput = requestFile ? executor.execWithInput?.bind(executor) : undefined;
    const parts = [`B="$(mktemp)"; curl -s -o "$B" -w '%{http_code}'`];
    if (opts.method && opts.method !== "GET") parts.push(`-X ${opts.method}`);
    if (requestFile) {
      parts.push("-H 'Content-Type: application/json'");
      parts.push(`--data-binary ${sq(`@${requestFile}`)}`);
    }
    parts.push(sq(url));
    const cmd = `${parts.join(" ")}; printf '\\n'; cat "$B"; rm -f "$B"`;

    let out: string;
    try {
      if (requestFile) {
        if (uploadWithInput) {
          // execWithInput bounds captured stdout. Upload only the request here
          // so a large analytics reply still uses the ordinary response reader.
          const uploaded = await uploadWithInput(
            containerCommand(container, `umask 077; cat > ${sq(requestFile)}`, { stdin: true }),
            Readable.from([payload!]),
          );
          if (uploaded.code !== 0) throw new Error(uploaded.stderr || "Edge request upload failed");
        } else {
          await executor.writeFile(requestFile, payload!, { mode: 0o600 });
          await executor.exec(`docker cp ${sq(requestFile)} ${sq(`${container}:${requestFile}`)}`);
        }
      }
      out = await executor.exec(containerCommand(container, cmd));
    } finally {
      if (requestFile) {
        await executor
          .exec(containerCommand(container, `rm -f ${sq(requestFile)}`))
          .catch((error) => {
            observeCaughtError(error, "platform/engine/lib/edge-management");
          });
        if (!uploadWithInput) {
          await executor.rm(requestFile).catch((error) => {
            observeCaughtError(error, "platform/engine/lib/edge-management");
          });
        }
      }
    }
    // "<status>\n<body>" — status first so a body containing newlines survives.
    const nl = out.indexOf("\n");
    if (nl < 0) return null;
    const statusCode = Number.parseInt(out.slice(0, nl).trim(), 10);
    if (!Number.isFinite(statusCode)) return null;
    return { statusCode, body: out.slice(nl + 1) };
  } catch (err) {
    observeCaughtError(err, "platform/engine/lib/edge-management");
    systemDebug(
      "edge-management",
      `execMgmt failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

/** Does this server need the exec transport (no SSH port-forward available)? */
async function needsExecTransport(serverId: string): Promise<boolean> {
  try {
    const executor = await sshManager.acquire(serverId);
    return typeof executor.forwardPort !== "function";
  } catch (diagnosticFailure) {
    observeCaughtError(diagnosticFailure, "platform/engine/lib/edge-management");
    return false;
  }
}

/**
 * One request to the mgmt API over whichever transport this server supports.
 * Tries the SSH forward first when the executor has one, and falls back to the
 * exec transport — a remote box whose forward is blocked still gets answered.
 */
async function mgmtRequest(
  serverId: string,
  path: string,
  opts: { method?: string; json?: unknown } = {},
): Promise<{ statusCode: number; body: string } | null> {
  if (!(await needsExecTransport(serverId))) {
    const viaTunnel = await tunnelRequest(serverId, OPENRESTY_MGMT_PORT, path, {
      method: opts.method,
      ...(opts.json !== undefined
        ? {
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(opts.json),
          }
        : {}),
    });
    if (viaTunnel) return { statusCode: viaTunnel.statusCode, body: viaTunnel.body };
  }
  return execMgmt(serverId, path, opts);
}

async function requestMgmtJson<T>(
  serverId: string,
  path: string,
  opts: { method?: string; json?: unknown } = {},
): Promise<T | null> {
  const res = await mgmtRequest(serverId, path, opts);
  if (!res || res.statusCode < 200 || res.statusCode >= 300) return null;
  try {
    return JSON.parse(res.body) as T;
  } catch {
    return null;
  }
}

export function fetchMgmt<T>(serverId: string, path: string): Promise<T | null> {
  return requestMgmtJson<T>(serverId, path);
}

/**
 * Resolve a missing server to the organization's local server row, then use
 * the same management client as every remote edge. The API's own loopback is
 * never a substitute for the edge's loopback. Failed publication returns null
 * so callers can distinguish persistence from an acknowledged edge update.
 */
export async function postEdgeMgmt<T = unknown>(
  serverId: string | null,
  path: string,
  json: unknown,
  organizationId?: string,
): Promise<T | null> {
  let target = serverId;
  if (!target) {
    if (!organizationId) {
      systemDebug("edge-management", `${path}: no serverId and no org to resolve the local one`);
      return null;
    }
    const local = await repos.server.findLocal(organizationId).catch((diagnosticFailure) => {
      observeCaughtError(diagnosticFailure, "platform/engine/lib/edge-management");
      return undefined;
    });
    if (!local) {
      systemDebug("edge-management", `${path}: no local server row; nothing of ours to configure`);
      return null;
    }
    target = local.id;
  }
  return postMgmtJson<T>(target, path, json).catch((err) => {
    errorDiagnostics.warn(
      "platform/engine/lib/edge-management",
      `[edge-mgmt] ${path} failed for server ${target}: ${safeErrorMessage(err)}`,
      err,
    );
    return null;
  });
}

export function postMgmtJson<T>(serverId: string, path: string, json: unknown): Promise<T | null> {
  return requestMgmtJson<T>(serverId, path, { method: "POST", json });
}

/**
 * Lightweight health probe for the OpenResty management port.
 */
export async function probeMgmt(serverId: string): Promise<boolean> {
  const res = await mgmtRequest(serverId, "/health");
  return res?.body.trim() === "ok";
}

/**
 * Open a streaming SSE connection to the OpenResty management API.
 * Returns a tunnel stream handle - caller pipes `handle.stream.on("data", ...)`
 * to the SSE client.
 */
export async function mgmtStream(serverId: string, path: string) {
  if (!(await needsExecTransport(serverId))) {
    return tunnelStream(serverId, OPENRESTY_MGMT_PORT, path);
  }
  return execMgmtStream(serverId, path);
}

/**
 * The exact bytes a `streamExec` chunk carried.
 *
 * `streamExec` is a RAW passthrough on every real executor — LocalExecutor and
 * SystemSshExecutor both say "Do NOT split on \n or trim here" — so a chunk is an
 * arbitrary slice of the byte stream: several frames, one frame, or half a line.
 * `rawData` is base64 of the untouched bytes; `message` is the decoded text and is
 * all a synthesized entry (a process error) has.
 *
 * Exported for the test that pins SSE framing across a mid-frame split.
 */
export function streamChunkBytes(log: LogEntry): Buffer {
  return log.rawData ? Buffer.from(log.rawData, "base64") : Buffer.from(log.message, "utf8");
}

/**
 * Live log streaming over the exec transport, for a local/containerized edge that
 * has no SSH forward. Same `TunnelStreamHandle` shape as the tunnel version, so
 * the SSE controllers piping this are unchanged.
 *
 * `curl -N` disables buffering so each frame the mgmt API emits arrives as it is
 * produced rather than in blocks. Without this branch the server-logs stream was
 * as dead as the analytics scrape on every CLI / compose install.
 */
async function execMgmtStream(serverId: string, path: string) {
  const executor = await sshManager.acquire(serverId);
  const container = await resolveOurEdgeContainer(executor);
  if (!container) throw new Error("No Openship edge container on this server");

  const { PassThrough } = await import("node:stream");
  const stream = new PassThrough();
  const url = `http://127.0.0.1:${OPENRESTY_MGMT_PORT}${path}`;

  // Tears the transport down on browser disconnect: LocalExecutor kills the curl child,
  // SshExecutor closes the ssh2 channel (which EPIPEs the remote curl within a heartbeat).
  // The edge log source is now the shared ring read by a per-connection cursor, so a
  // lingering orphan can no longer steal frames from the next subscriber — but it still
  // holds an SSH session, so honouring the signal keeps refreshes from exhausting
  // sshd `MaxSessions`. The bare→containerized switch removed the TCP socket whose close
  // used to do this for free; the abort signal is the replacement handle.
  const abort = new AbortController();
  let ended = false;
  let torndown = false;
  let forwarded = false;
  const errParts: string[] = [];
  const finish = () => {
    if (ended) return;
    ended = true;
    stream.end();
  };

  // `-f` fails fast on an HTTP error (no body, non-zero exit) and `-S` lets curl print
  // WHY to stderr even under `-s` — together they turn a dead/misrouted edge from a
  // silent empty stream into a diagnosable one. `-N` keeps SSE unbuffered.
  void executor
    .streamExec(
      containerCommand(container, `curl -fsSN ${sq(url)}`),
      (log) => {
        if (ended) return;
        // Only stdout is the SSE body. stderr (curl's own error under `-S`) is a
        // DIAGNOSTIC — forwarding it as bytes would both corrupt framing (dropped by
        // the client) and mask the real failure by making `forwarded` go true.
        if (log.level !== "info") {
          if (log.message) errParts.push(log.message);
          return;
        }
        // Byte-exact, NO added newline: frame boundaries belong to the edge
        // (pipe_stream.lua emits `event: request\ndata: …\n\n`); a chunk is an arbitrary
        // slice, so any reinterpretation here truncates a frame and the client drops it.
        const bytes = streamChunkBytes(log);
        if (bytes.length) forwarded = true;
        stream.write(bytes);
      },
      { signal: abort.signal },
    )
    .then((result) => {
      // curl exited on its own. If it never forwarded a byte and this wasn't an
      // intentional teardown, the browser would otherwise just watch the socket close
      // with no reason — the exec transport has no HTTP status to hand back (it used to
      // report 200 unconditionally, so a dead edge looked identical to an idle one).
      // Speak the failure in a frame the client already understands (`event: error`),
      // the same shape the tunnel-null path in the controller uses.
      if (!torndown && !forwarded && !ended) {
        const detail = errParts.join("").trim() || (result?.output || "").trim();
        const reason =
          `Couldn't reach the Openship edge's log service on this server` +
          `${detail ? `: ${detail}` : ""}. Make sure the edge is running ` +
          "(`docker ps` should show openship-edge) and redeploy the routing if it isn't.";
        stream.write(`event: error\ndata: ${JSON.stringify({ error: reason })}\n\n`);
      }
      finish();
    })
    .catch((err) => {
      observeCaughtError(err, "platform/engine/lib/edge-management");
      systemDebug(
        "edge-management",
        `execMgmtStream ended: ${err instanceof Error ? err.message : String(err)}`,
      );
      finish();
    });

  return {
    stream,
    // No HTTP response envelope to read — curl consumed it. A real failure now arrives as
    // the `error` frame above rather than a status code, so this stays 200.
    statusCode: 200,
    headers: {} as Record<string, string>,
    destroy: () => {
      torndown = true;
      abort.abort();
      finish();
      stream.destroy();
    },
  };
}
