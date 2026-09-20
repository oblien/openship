import { repos } from "@repo/db";
import { AppError, safeErrorMessage } from "@repo/core";
import { OperationError, ProjectLogSchemas, type ServerLogsInput } from "@repo/contracts";
import { deployLuaScripts } from "@repo/adapters";
import type { ExecutionContext } from "../../../context";
import type { ProjectDependencies } from "../../../projects";
import type { ResourceServices } from "../../../resource-operations";
import { assertResourceInOrg } from "../../lib/resource-access";
import { env } from "../../config/index";
import { getAdminOblienClient } from "../../lib/oblien-user-client";
import { cloudClient } from "../../lib/cloud/client";
import { getOpenRestyPaths } from "../../lib/openresty-paths";
import { sshManager } from "../../lib/ssh-manager";
import { resolveProjectTrafficSource, resolveProjectTrafficSources, fetchMgmt, mgmtStream, probeMgmt, type ProjectTrafficSource } from "../../lib/project-analytics";
import * as projectService from "./project.service";

// Owned by the HTTP process or an isolated native worker, never shared between installations.
const luaDeployedServers = new Set<string>();

async function assertTrafficAccess(ctx: ExecutionContext, sources: ProjectTrafficSource[]) {
  for (const source of sources) {
    if (source.kind === "cloud") {
      if (!env.CLOUD_MODE && ctx.scopeMode === "fixed")
        throw new AppError("This cloud link has no tenant mapping. Connect directly with the cloud organizationId.", 409, "CLOUD_SCOPE_UNAVAILABLE");
      continue;
    }
    // A deployment snapshot must not redirect project log access to another tenant's server.
    const server = await repos.server.get(source.serverId);
    assertResourceInOrg(server, "Server", ctx.organizationId, source.serverId);
    if (server.isLocal && process.env.OPENSHIP_NATIVE === "true" && process.env.OPENSHIP_NATIVE_ALLOW_HOST_EXECUTION !== "true")
      throw new AppError("Host execution is disabled by this native installation's policy", 403, "HOST_EXECUTION_DISABLED");
  }
}

function extractCloudStreamToken(result: unknown): { stream_url: string; token: string } | null {
  // The payload nesting DIFFERS by path:
  //   • admin-direct (Oblien SDK):  { success, data: { stream_url, token, … } }  ← 1 level
  //   • cloud-proxied (SaaS wraps the SDK response again): { data: { success, data: { stream_url, token } } }  ← 2 levels
  // So walk down through nested `data`/`result` wrappers until we hit the object
  // that actually carries stream_url + token, instead of assuming a fixed depth.
  let node: unknown = result;
  for (let depth = 0; depth < 4 && node && typeof node === "object"; depth++) {
    const obj = node as Record<string, unknown>;
    const streamUrl = obj.stream_url ?? obj.streamUrl ?? obj.url ?? obj.sse_url ?? obj.endpoint;
    const token = obj.token ?? obj.stream_token ?? obj.streamToken ?? obj.access_token ?? obj.jwt;
    if (typeof streamUrl === "string" && typeof token === "string") {
      return { stream_url: streamUrl, token };
    }
    node = obj.data ?? obj.result;
  }
  return null;
}

function extractCloudRequestLogs(result: unknown): unknown[] {
  // Same nesting problem as the stream token: the request array can sit at
  // result.data (admin-direct) or result.data.data (cloud-proxied). Walk down
  // nested `data`/`result` wrappers and return the first array found at a known
  // key or as a bare `data` array.
  let node: unknown = result;
  for (let depth = 0; depth < 4 && node && typeof node === "object"; depth++) {
    const obj = node as Record<string, unknown>;
    for (const key of ["requests", "logs", "items", "rows"]) {
      if (Array.isArray(obj[key])) return obj[key] as unknown[];
    }
    if (Array.isArray(obj.data)) return obj.data as unknown[];
    node = obj.data ?? obj.result;
  }
  return Array.isArray(result) ? (result as unknown[]) : [];
}

async function serverLogStreamToken(ctx: ExecutionContext, id: string, input?: ServerLogsInput) {
  const { organizationId } = ctx;
  const project = await repos.project.findById(id);
  assertResourceInOrg(project, "Project", organizationId, id);

  const source = await resolveProjectTrafficSource(id, { domain: input?.domain });
  if (!source) {
    throw new OperationError("No domain configured for this project", 400, "NO_DOMAIN_CONFIGURED");
  }

  await assertTrafficAccess(ctx, [source]);

  if (source.kind === "cloud") {
    const client = getAdminOblienClient();
    let tokenResult: unknown = null;

    try {
      tokenResult = client
        ? await client.analytics.streamToken(source.domain)
        : await cloudClient({ organizationId }).analytics.streamToken(source.domain);
    } catch (err) {
      // Token mint failed. This is a CLOUD project — do NOT claim "self-hosted"
      // (that sends the client to /server-logs/stream, which 400s for cloud).
      // Report "unavailable" so the client shows recent logs without erroring.
      console.warn(
        `[server-logs] cloud stream-token mint failed for ${source.domain}: ${safeErrorMessage(err)}`,
      );
      return { kind: "unavailable" as const };
    }

    const tokenData = extractCloudStreamToken(tokenResult);
    if (!tokenData) {
      // 200 but unparseable shape. Surface the KEYS (never the token value) so a
      // SaaS response-shape change is diagnosable instead of silently degrading.
      const rt = (tokenResult ?? {}) as Record<string, unknown>;
      const inner = (rt.data ?? rt.result ?? rt) as Record<string, unknown> | null;
      console.warn(
        `[server-logs] cloud stream-token unparseable for ${source.domain}; ` +
          `top keys=[${Object.keys(rt).join(",")}] ` +
          `inner keys=[${inner && typeof inner === "object" ? Object.keys(inner).join(",") : ""}]`,
      );
      return { kind: "unavailable" as const };
    }
    return { kind: "cloud" as const, url: tokenData.stream_url, token: tokenData.token };
  }

  return { kind: "self-hosted" as const };
}

async function recentServerLogs(ctx: ExecutionContext, id: string, input?: ServerLogsInput & { limit?: number }) {
  const { organizationId } = ctx;
  const project = await repos.project.findById(id);
  assertResourceInOrg(project, "Project", organizationId, id);

  const limit = input?.limit ?? 50;

  // A specific `?domain=` scopes to one route (the switcher). Without it, combine EVERY
  // tracked domain — same plural fan-out as getAnalyticsOverview — so a multi-route
  // project's recent-log view is never empty just because the primary happens to be idle.
  const requested = input?.domain;
  const sources = await resolveProjectTrafficSources(
    id,
    requested ? { domain: requested } : undefined,
  );
  if (sources.length === 0) {
    return { logs: [] };
  }

  await assertTrafficAccess(ctx, sources);

  // The edge keys its ring buffer BY host and doesn't repeat the host inside each row, so
  // stamp it on here — that's the only way the combined view can label which domain a row
  // hit. A row that already carries a host (a cloud relay might) keeps it.
  const tagHost = (rows: unknown[], host: string): unknown[] =>
    rows.map((r) =>
      r && typeof r === "object" && !Array.isArray(r) && !("host" in (r as object))
        ? { ...(r as Record<string, unknown>), host }
        : r,
    );

  // Ordering scale in seconds, tolerant of every producer's field/unit: epoch seconds
  // (mgmt ring `ts`), epoch millis, or an ISO string (a cloud relay).
  const tsOf = (r: unknown): number => {
    const o = (r ?? {}) as Record<string, unknown>;
    const raw = o.ts ?? o.timestamp ?? o.date;
    if (typeof raw === "number") return raw > 1_000_000_000_000 ? raw / 1000 : raw;
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n > 1_000_000_000_000 ? n / 1000 : n;
    const parsed = Date.parse(String(raw ?? ""));
    return Number.isFinite(parsed) ? parsed / 1000 : 0;
  };

  const collected: unknown[][] = [];

  const cloudSources = sources.filter((s) => s.kind === "cloud");
  if (cloudSources.length) {
    const client = getAdminOblienClient();
    // Settle per-domain: one domain's upstream failure must not blank the others'.
    const settled = await Promise.allSettled(
      cloudSources.map(async (s) => {
        const result = client
          ? await client.analytics.requests(s.domain, { limit })
          : await cloudClient({ organizationId }).analytics.requests(s.domain, { limit });
        return tagHost(extractCloudRequestLogs(result), s.domain);
      }),
    );
    for (const r of settled) if (r.status === "fulfilled") collected.push(r.value);
  }

  const selfHostedSources = sources.filter((s) => s.kind === "self-hosted");
  if (selfHostedSources.length) {
    const perDomain = await Promise.all(
      selfHostedSources.map(async ({ domain, serverId }) => {
        const entries = await fetchMgmt<unknown[]>(
          serverId,
          `/logs/recent?domain=${encodeURIComponent(domain)}&limit=${limit}`,
        );
        return tagHost(entries ?? [], domain);
      }),
    );
    collected.push(...perDomain);
  }

  // Newest-first across ALL domains, then cap: the combined view shows the last `limit`
  // requests project-wide, not `limit` per domain.
  const logs = collected
    .flat()
    .sort((a, b) => tsOf(b) - tsOf(a))
    .slice(0, limit);

  return { logs };
}


export const projectLogOperations = { getServerLogStreamToken: serverLogStreamToken, recentServerLogs } satisfies ResourceServices<typeof ProjectLogSchemas>;

export const subscribeProjectLogs: NonNullable<ProjectDependencies["subscribeLogs"]> = (ctx, id, input) => async (write) => {
  const stream = await projectService.streamRuntimeLogs(id, ctx.organizationId, entry => {
    write("log", JSON.stringify({ type: "log", data: entry.rawData, message: entry.message, timestamp: entry.timestamp, level: entry.level }));
  }, input);
  if (stream.serverId) sshManager.retain(stream.serverId);
  let closed = false;
  return {
    success: true,
    async unsubscribe() {
      if (closed) return;
      closed = true;
      try { await stream.cleanup(); }
      finally { if (stream.serverId) sshManager.release(stream.serverId); }
    },
  };
};

/** Resolve and authorize the source before opening HTTP headers or acquiring a stream. */
export const openProjectServerLogs: NonNullable<ProjectDependencies["openServerLogs"]> = async (ctx, id, input, options) => {
  const project = await repos.project.findById(id);
  assertResourceInOrg(project, "Project", ctx.organizationId, id);
  const source = await resolveProjectTrafficSource(id, input);
  if (!source || source.kind !== "self-hosted")
    throw new OperationError("Use stream-token endpoint for cloud projects", 400, "SERVER_LOG_STREAM_UNAVAILABLE");
  await assertTrafficAccess(ctx, [source]);
  const { domain, serverId } = source;
  const { signal } = options;

  return (async function* () {
    signal?.throwIfAborted();
    let conn: Awaited<ReturnType<typeof mgmtStream>> = null;
    const abort = () => conn?.destroy();
    sshManager.retain(serverId);
    signal?.addEventListener("abort", abort, { once: true });
    try {
      if (!luaDeployedServers.has(serverId)) {
        try {
          const executor = await sshManager.acquire(serverId);
          const paths = await getOpenRestyPaths(serverId, executor);
          await deployLuaScripts(executor, paths);
          luaDeployedServers.add(serverId);
        } catch {
          // Non-fatal: scripts may already be up to date.
        }
      }
      signal?.throwIfAborted();
      let failure = "";
      try { conn = await mgmtStream(serverId, `/logs/stream?domain=${encodeURIComponent(domain)}`); }
      catch (error) { failure = safeErrorMessage(error); }
      signal?.throwIfAborted();
      if (!conn) {
        const edgeUp = !failure && (await probeMgmt(serverId).catch(() => false));
        const error = edgeUp
          ? `The Openship edge is running but refused the log stream for ${domain}. Check that this domain is routed through the edge, then retry.`
          : `Couldn't reach the Openship edge's log service on this server${failure ? `: ${failure}` : ""}. Make sure the edge is running (\`docker ps\` should show openship-edge) and redeploy the routing if it isn't.`;
        yield new TextEncoder().encode(`event: error\ndata: ${JSON.stringify({ error })}\n\n`);
        return;
      }
      try {
        // Node's iterator applies backpressure without decoding or re-framing bytes.
        for await (const chunk of conn.stream) {
          signal?.throwIfAborted();
          yield chunk instanceof Uint8Array ? chunk : new TextEncoder().encode(String(chunk));
        }
        signal?.throwIfAborted();
      } catch (error) {
        signal?.throwIfAborted();
        // The existing relay ends on an upstream close/error; it does not invent a frame.
      }
    } finally {
      signal?.removeEventListener("abort", abort);
      conn?.destroy();
      sshManager.release(serverId);
    }
  })();
};
