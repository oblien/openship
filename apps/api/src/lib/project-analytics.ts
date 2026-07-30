/**
 * Shared helpers for resolving a project's tracked domain, server,
 * and querying the OpenResty management API.
 *
 * The actual HTTP-over-SSH-tunnel logic lives in `./ssh-tunnel.ts`.
 * This file provides the OpenResty-specific convenience wrappers and
 * project → domain + server resolution.
 *
 * Used by:
 *   - analytics.service.ts  (summary, periods)
 *   - project.controller.ts (server log stream, recent logs)
 *   - analytics-scraper.ts  (periodic scrape via SSH)
 */

import { repos, type Project } from "@repo/db";
import {
  OPENRESTY_MGMT_PORT,
  containerCommand,
  resolveOurEdgeContainer,
  sq,
  type LogEntry,
} from "@repo/adapters";
import { tunnelRequest, tunnelStream } from "./ssh-tunnel";
import { sshManager } from "./ssh-manager";
import { isOblienBackedDeployment } from "./platform-mode";
import { systemDebug } from "./system-debug";

export type { TunnelStreamHandle } from "./ssh-tunnel";

// ─── Domain normalisation ────────────────────────────────────────────────────

/**
 * Normalize a hostname to match OpenResty's tracking key format.
 * Lua `site_logger.lua` stores counters under lowercase, no-www keys.
 */
export function normalizeTrackedDomain(hostname: string): string {
  return hostname
    .trim()
    .toLowerCase()
    .replace(/^www\./, "");
}

// ─── Project → domain + server resolution ────────────────────────────────────

export interface ProjectTracking {
  domain: string;
  serverId: string;
}

export type ProjectTrafficSource =
  | {
      kind: "self-hosted";
      domain: string;
      serverId: string;
      deployTarget: string | null;
    }
  | {
      kind: "cloud";
      domain: string;
      deployTarget: "cloud";
    };

async function resolveTrafficRuntime(project: Project) {
  let deployTarget: string | null = null;
  let serverId: string | null = null;

  if (project.activeDeploymentId) {
    const dep = await repos.deployment.findById(project.activeDeploymentId);
    const meta = dep?.meta as { deployTarget?: string; serverId?: string } | null;
    deployTarget = meta?.deployTarget ?? null;
    if (meta?.serverId) serverId = meta.serverId;
  }

  return { deployTarget, serverId };
}

async function resolveProjectTrackedDomains(project: Project): Promise<string[]> {
  const rows = await repos.domain.listByProject(project.id);
  const hostnames = rows
    .map((domain) => domain.hostname)
    .filter((hostname): hostname is string => Boolean(hostname?.trim()))
    .map(normalizeTrackedDomain);

  return Array.from(new Set(hostnames));
}

/**
 * Resolve the tracked domain and server for a project.
 *
 * Domain resolution order:
 *   1. Primary domain from DB (`domain` table)
 *   2. Slug-based managed subdomain (`project.slug.baseDomain`)
 *
 * Server resolution order:
 *   1. Active deployment's `meta.serverId`
 *   2. First configured server (single-server setups)
 */
export async function resolveProjectTracking(projectId: string): Promise<ProjectTracking | null> {
  const source = await resolveProjectTrafficSource(projectId);
  if (!source || source.kind !== "self-hosted") {
    return null;
  }

  return { domain: source.domain, serverId: source.serverId };
}

/**
 * Map a fixed list of tracked domains to their traffic sources — the shared core
 * of the single/plural resolvers below. SaaS/OpenShip Cloud deploys observe
 * traffic at the Oblien edge; self-hosted deploys observe it via the target
 * server's OpenResty management API. Empty domain list (or no resolvable server)
 * → no sources.
 */
async function buildTrafficSourcesForDomains(
  project: Project,
  domains: string[],
): Promise<ProjectTrafficSource[]> {
  if (domains.length === 0) return [];

  let { deployTarget, serverId } = await resolveTrafficRuntime(project);

  if (isOblienBackedDeployment(deployTarget)) {
    return domains.map((domain) => ({
      kind: "cloud" as const,
      domain,
      deployTarget: "cloud" as const,
    }));
  }

  // Server: deployment meta first, then first configured server.
  if (!serverId) {
    const servers = await repos.server.list();
    serverId = servers[0]?.id ?? null;
  }
  if (!serverId) return [];

  return domains.map((domain) => ({
    kind: "self-hosted" as const,
    domain,
    serverId,
    deployTarget,
  }));
}

/**
 * Resolve where request traffic is observed for ONE of the project's domains: a
 * validated `domain` override (route switch), else the primary tracked route.
 */
export async function resolveProjectTrafficSource(
  projectId: string,
  opts?: {
    /** Restrict traffic to ONE of the project's domains (route switch). Validated
     *  against the project's tracked domains — an unknown value is ignored and we
     *  fall back to the primary, so a client can never fetch logs for an arbitrary
     *  (cross-tenant) host. */
    domain?: string;
  },
): Promise<ProjectTrafficSource | null> {
  const project = await repos.project.findById(projectId);
  if (!project) return null;

  // Domain: a validated override (route switch), else the primary tracked route.
  let domain: string | null = null;
  const requested = opts?.domain?.trim();
  if (requested) {
    const normalized = normalizeTrackedDomain(requested);
    const tracked = (await resolveProjectTrackedDomains(project)).map(normalizeTrackedDomain);
    if (tracked.includes(normalized)) domain = normalized;
  }
  if (!domain) {
    const primaryDomain = await repos.domain.getPrimaryByProject(projectId);
    domain = primaryDomain?.hostname ? normalizeTrackedDomain(primaryDomain.hostname) : null;
  }
  if (!domain) return null;

  const [source] = await buildTrafficSourcesForDomains(project, [domain]);
  return source ?? null;
}

/**
 * Resolve all domains that should contribute to project-level overview analytics.
 * Normal apps usually have one domain; compose/service apps can have one domain
 * per exposed service, so the overview aggregates them.
 */
export async function resolveProjectTrafficSources(
  projectId: string,
  opts?: {
    /** Scope to ONE tracked domain (route switch). Validated + primary fallback,
     *  identical to resolveProjectTrafficSource, returned as a one-element array.
     *  Omit to aggregate every tracked domain. */
    domain?: string;
  },
): Promise<ProjectTrafficSource[]> {
  if (opts?.domain) {
    const source = await resolveProjectTrafficSource(projectId, { domain: opts.domain });
    return source ? [source] : [];
  }

  const project = await repos.project.findById(projectId);
  if (!project) return [];

  const domains = await resolveProjectTrackedDomains(project);
  return buildTrafficSourcesForDomains(project, domains);
}

// ─── OpenResty management API wrappers ───────────────────────────────────────

/**
 * GET JSON from the OpenResty management API through SSH tunnel.
 */
/**
 * ─── Reaching the edge's management API ─────────────────────────────────────
 *
 * The mgmt API listens on `127.0.0.1:9145` INSIDE the edge, and there are two
 * completely different ways to get there depending on where the edge lives:
 *
 *   remote server → SSH port-forward to its loopback (`tunnelRequest`).
 *   local host    → NO forward is possible. The local/host executor has no
 *                   `forwardPort` at all (only ssh-executor and
 *                   system-ssh-executor implement it), so `tunnelConnect` threw
 *                   "does not support port tunnelling", every fetch returned
 *                   null, `probeMgmt` said false, and the scraper skipped the
 *                   server on every tick — analytics could never work on a CLI /
 *                   compose install, permanently showing zeros.
 *
 *                   And a forward wouldn't have helped: the edge runs with
 *                   network_mode: host, so :9145 is the HOST's loopback while the
 *                   api container has its own — and the mgmt server binds
 *                   127.0.0.1 only, so host.docker.internal is refused too.
 *
 *                   The one place that loopback IS reachable is inside the edge
 *                   container, so we exec there — the same route vhost writes and
 *                   certbot already take. `curl` ships in the edge image.
 *
 * Both transports return the same shape so every caller below is unchanged.
 */
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
    const parts = [`B="$(mktemp)"; curl -s -o "$B" -w '%{http_code}'`];
    if (opts.method && opts.method !== "GET") parts.push(`-X ${opts.method}`);
    if (opts.json !== undefined) {
      parts.push("-H 'Content-Type: application/json'");
      parts.push(`--data-binary ${sq(JSON.stringify(opts.json))}`);
    }
    parts.push(sq(url));
    const cmd = `${parts.join(" ")}; printf '\\n'; cat "$B"; rm -f "$B"`;

    const out = await executor.exec(containerCommand(container, cmd));
    // "<status>\n<body>" — status first so a body containing newlines survives.
    const nl = out.indexOf("\n");
    if (nl < 0) return null;
    const statusCode = Number.parseInt(out.slice(0, nl).trim(), 10);
    if (!Number.isFinite(statusCode)) return null;
    return { statusCode, body: out.slice(nl + 1) };
  } catch (err) {
    systemDebug("analytics", `execMgmt failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/** Does this server need the exec transport (no SSH port-forward available)? */
async function needsExecTransport(serverId: string): Promise<boolean> {
  try {
    const executor = await sshManager.acquire(serverId);
    return typeof executor.forwardPort !== "function";
  } catch {
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

export async function fetchMgmt<T>(serverId: string, path: string): Promise<T | null> {
  const res = await mgmtRequest(serverId, path);
  if (!res || res.statusCode < 200 || res.statusCode >= 300) return null;
  try {
    return JSON.parse(res.body) as T;
  } catch {
    return null;
  }
}

/**
 * POST to the OpenResty management API through SSH tunnel.
 */
export async function postMgmt<T>(serverId: string, path: string): Promise<T | null> {
  const res = await mgmtRequest(serverId, path, { method: "POST" });
  if (!res || res.statusCode < 200 || res.statusCode >= 300) return null;
  try {
    return JSON.parse(res.body) as T;
  } catch {
    return null;
  }
}

/**
 * POST a JSON body to the OpenResty management API through the SSH tunnel.
 * Used to push per-route rules into the edge's `rules` shared dict (reload-free).
 */
export async function postMgmtJson<T>(
  serverId: string,
  path: string,
  json: unknown,
): Promise<T | null> {
  const res = await mgmtRequest(serverId, path, { method: "POST", json });
  if (!res || res.statusCode < 200 || res.statusCode >= 300) return null;
  try {
    return JSON.parse(res.body) as T;
  } catch {
    return null;
  }
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

  let ended = false;
  const finish = () => {
    if (ended) return;
    ended = true;
    stream.end();
  };

  // Fire-and-forget: resolves when curl exits (client abort or edge close), which
  // is exactly when the SSE stream should end.
  void executor
    .streamExec(containerCommand(container, `curl -sN ${sq(url)}`), (log) => {
      // Byte-exact, and NO added newline. This used to write `${log.message}\n`,
      // which broke SSE framing: chunks split anywhere, so the extra newline landed
      // inside a `data:` line as often as after one. A frame cut mid-JSON parses as
      // truncated and the browser drops the event (the client swallows malformed
      // data by design), which is why the live tail showed nothing until you
      // reloaded and the history fetch filled it in. Frame boundaries belong to the
      // edge (pipe_stream.lua already emits `event: request\ndata: …\n\n`); this
      // transport must not reinterpret them.
      if (!ended) stream.write(streamChunkBytes(log));
    })
    .then(finish)
    .catch((err) => {
      systemDebug("analytics", `execMgmtStream ended: ${err instanceof Error ? err.message : String(err)}`);
      finish();
    });

  return {
    stream,
    // The exec transport has no HTTP response envelope to read — curl consumed it.
    // Reaching here means the stream is open, so report the equivalent of 200.
    statusCode: 200,
    headers: {} as Record<string, string>,
    destroy: () => {
      finish();
      stream.destroy();
    },
  };
}
