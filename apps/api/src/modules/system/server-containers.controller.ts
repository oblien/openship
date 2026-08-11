/**
 * Server managed-CONTAINER controller — /api/system/servers/:id/containers.
 *
 * The container sibling of `server-modules.controller.ts`: same server:read /
 * server:write tags, same org-scoping (an out-of-org id 404s indistinguishably),
 * same `assertNotCloud` hard guard. Where module apply is a plain POST, the
 * container apply STREAMS — an image swap pulls + recreates + verifies over SSH,
 * so the modal watches `steps`/`log`/`complete` frames and can re-attach to an
 * in-flight swap (including one the boot auto-update started).
 */

import type { Context } from "hono";
import { repos } from "@repo/db";
import { getRequestContext } from "../../lib/request-context";
import { assertNotCloud } from "../../lib/controller-helpers";
import { streamSSE } from "../../lib/sse";
import {
  applyAllContainers as applyAll,
  detectServerContainers,
  loadOrgContainerIssues,
  runContainerApply,
  scanOrgContainers,
  type ContainerApplyIntent,
  type ServerContainerView,
} from "./server-containers.service";
import {
  getActiveContainerApplySession,
  subscribeContainerApplySession,
} from "../../lib/server-container-session";

async function resolveServer(c: Context) {
  const id = c.req.param("id")!;
  const ctx = getRequestContext(c);
  const server = await repos.server.getInOrganization(id, ctx.organizationId);
  return { id, server };
}

function parseComponent(c: Context): "edge" | "mail" | null {
  const raw = c.req.param("component");
  return raw === "edge" || raw === "mail" ? raw : null;
}

/** GET /servers/:id/containers — cached edge/mail drift for the server. */
export async function listServerContainers(c: Context) {
  const cloudGuard = assertNotCloud(c); if (cloudGuard) return cloudGuard;
  const { id, server } = await resolveServer(c);
  if (!server) return c.json({ error: "Server not found" }, 404);
  const rows = await repos.serverContainerStatus.listByServer(id);
  return c.json(rows);
}

/**
 * Every org server paired with its cached edge/mail rows — the shape the global
 * Infrastructure view renders. All servers are listed (even ones with nothing
 * tracked yet, so a fresh box shows up and invites a scan); rows come from the
 * one `server_container_status` cache.
 */
async function groupedContainers(organizationId: string) {
  const [servers, rows, projectCounts] = await Promise.all([
    repos.server.listByOrganization(organizationId),
    repos.serverContainerStatus.listByOrg(organizationId),
    repos.project.countActiveByServer(organizationId),
  ]);
  const byServer = new Map<string, typeof rows>();
  for (const r of rows) {
    (byServer.get(r.serverId) ?? byServer.set(r.serverId, []).get(r.serverId)!).push(r);
  }
  // projectCount rides along so the view can tell an ABSENT edge that's a real
  // issue (this box hosts projects) from one that's just an offer — the same
  // rule containerIssues uses — without a second round-trip.
  return servers.map((s) => ({
    server: {
      id: s.id,
      name: s.name ?? s.sshHost,
      sshHost: s.sshHost,
      isLocal: s.isLocal,
      projectCount: projectCounts[s.id] ?? 0,
    },
    components: byServer.get(s.id) ?? [],
  }));
}

/** GET /system/containers — every org server's cached edge/mail rows (no probe). */
export async function listAllContainers(c: Context) {
  const cloudGuard = assertNotCloud(c); if (cloudGuard) return cloudGuard;
  const ctx = getRequestContext(c);
  return c.json(await groupedContainers(ctx.organizationId));
}

/**
 * POST /system/containers/scan — detect-only refresh across the org's servers,
 * then return the grouped view. Never applies (the toggle-gated boot/cron sweep
 * owns that), so a manual scan can't race the auto-update path.
 */
export async function scanAllContainers(c: Context) {
  const cloudGuard = assertNotCloud(c); if (cloudGuard) return cloudGuard;
  const ctx = getRequestContext(c);
  await scanOrgContainers(ctx.organizationId).catch(() => {});
  return c.json(await groupedContainers(ctx.organizationId));
}

/**
 * GET /system/containers/behind — org-wide drift summary for the home nudge:
 * how many servers have a behind edge/mail container, and how many components in
 * total. Read from the cache, so it's cheap on every home render.
 */
export async function containersBehind(c: Context) {
  const cloudGuard = assertNotCloud(c); if (cloudGuard) return cloudGuard;
  const ctx = getRequestContext(c);
  const rows = await repos.serverContainerStatus.listBehindByOrg(ctx.organizationId);
  const servers = new Set(rows.map((r) => r.serverId)).size;
  return c.json({ servers, components: rows.length });
}

/**
 * GET /system/containers/issues — org-wide ISSUE rollup for the attention dot +
 * home surface. An issue is an edge that needs hands-on action: the edge is
 * `down` (installed but not running), or ABSENT on a server that actually hosts
 * projects (a box with no active deployments doesn't need an edge, so a missing
 * one there is an offer, not an alarm). Behind (an update is available) is NOT an
 * issue — that's the separate `containersBehind` updates surface. Mail is
 * optional (mail-server only), so a mail state never raises this alarm.
 *
 * Read from the cache + the active-deployment→server attribution, so it's cheap
 * on every home/settings render.
 */
export async function containerIssues(c: Context) {
  const cloudGuard = assertNotCloud(c); if (cloudGuard) return cloudGuard;
  const ctx = getRequestContext(c);
  return c.json(await loadOrgContainerIssues(ctx.organizationId));
}

/**
 * POST /system/containers/apply-all — update every behind container and restart
 * every stopped one across the org, in one click.
 *
 * Targets come from the cache server-side (never from the body): the only input is
 * WHICH intents to run, so "Update all" and "Restart stopped" are the same endpoint.
 * Returns the classification immediately — `started` runs detached as replayable
 * per-server sessions, `skipped` lists what needs the server's own page (takeover
 * consent, a missing container, or an apply already in flight).
 */
export async function applyAllContainers(c: Context) {
  const cloudGuard = assertNotCloud(c); if (cloudGuard) return cloudGuard;
  const ctx = getRequestContext(c);
  const body = await c.req.json().catch(() => ({}) as { intents?: unknown });
  const requested = Array.isArray((body as { intents?: unknown }).intents)
    ? ((body as { intents: unknown[] }).intents.filter(
        (i): i is ContainerApplyIntent => i === "update" || i === "repair",
      ))
    : undefined;
  if (requested && requested.length === 0) {
    return c.json({ error: "intents must contain \"update\" and/or \"repair\"" }, 400);
  }
  const result = await applyAll(ctx.organizationId, requested);
  // The router audits this as server:write on "*". Record WHICH boxes were acted on
  // and which were refused — otherwise the log says someone pressed a fleet-wide
  // button and nothing about the containers that restarted because of it.
  c.set("auditAfter", {
    intents: requested ?? ["update", "repair"],
    started: result.started.map((s) => `${s.serverId}:${s.component}:${s.intent}`),
    skipped: result.skipped.map((s) => `${s.serverId}:${s.component}:${s.reason}`),
  });
  return c.json(result);
}

/** POST /servers/:id/containers/scan — refresh the drift cache now. */
export async function scanServerContainers(c: Context) {
  const cloudGuard = assertNotCloud(c); if (cloudGuard) return cloudGuard;
  const { server } = await resolveServer(c);
  if (!server) return c.json({ error: "Server not found" }, 404);
  const views: ServerContainerView[] = await detectServerContainers(server).catch((err: unknown) => {
    throw new Error(`scan failed: ${(err as Error).message}`);
  });
  return c.json({ ok: true, containers: views });
}

/**
 * POST /servers/:id/containers/:component/apply/stream — converge the edge or mail
 * container, streaming progress. Idempotent per (server, component): a second call
 * while a run is in flight RE-ATTACHES to the running session (replaying its steps
 * + logs) instead of starting a second one.
 *
 * `?intent=repair` asks for a START rather than an image swap — the only way to
 * recover a stopped mail engine, whose swap path deliberately refuses a non-running
 * container (see `reconcileServerMail`). Anything else means `update`.
 */
export async function applyServerContainerStream(c: Context) {
  const cloudGuard = assertNotCloud(c); if (cloudGuard) return cloudGuard;
  const { server } = await resolveServer(c);
  if (!server) return c.json({ error: "Server not found" }, 404);

  const component = parseComponent(c);
  if (!component) return c.json({ error: "Unknown component" }, 400);
  const intent: ContainerApplyIntent = c.req.query("intent") === "repair" ? "repair" : "update";

  // Fail fast BEFORE opening the stream: an unprovisioned mail box has nothing to
  // swap OR start, and the orchestrator would otherwise surface it only as a log
  // line. Applies to both intents — repair reuses the provisioned secrets on disk.
  if (component === "mail") {
    const record = await repos.mailServer.get(server.id).catch(() => undefined);
    if (!record) return c.json({ error: "No mail server is provisioned on this server" }, 400);
  }

  const { session } = runContainerApply(server, component, intent);

  return streamSSE(c, async (sseStream) => {
    let closed = false;
    const writer = (event: string, data: string): boolean => {
      if (closed) return false;
      try {
        void sseStream.writeSSE({ event, data });
        return true;
      } catch {
        return false;
      }
    };

    const { success } = subscribeContainerApplySession(session.id, writer);
    if (!success || session.status !== "running") return;

    await new Promise<void>((resolve) => {
      const iv = setInterval(() => {
        if (closed || session.status !== "running") {
          clearInterval(iv);
          resolve();
        }
      }, 1000);
      sseStream.onAbort(() => {
        closed = true;
        clearInterval(iv);
        resolve();
      });
    });
  });
}

/**
 * GET /servers/:id/containers/:component/apply/session — read-only status.
 *
 * The mount-time re-attach path polls this before opening the modal: a running
 * swap hands back its session id so the client attaches via GET, never a POST
 * (which would start a fresh run if the swap finished in the detect→open
 * window). No running session → {active:false}.
 */
export async function getServerContainerApplySession(c: Context) {
  const cloudGuard = assertNotCloud(c); if (cloudGuard) return cloudGuard;
  const { server } = await resolveServer(c);
  if (!server) return c.json({ error: "Server not found" }, 404);

  const component = parseComponent(c);
  if (!component) return c.json({ error: "Unknown component" }, 400);

  const session = getActiveContainerApplySession(server.id, component);
  if (!session) return c.json({ active: false }, 200);

  return c.json({
    active: true,
    sessionId: session.id,
    status: session.status,
    serverId: session.serverId,
    component: session.component,
  });
}

/**
 * GET /servers/:id/containers/:component/apply/stream — read-only SSE attach.
 *
 * The GET sibling of the POST apply stream, for page reloads: it subscribes to
 * an already-running swap (replaying steps+logs+terminal) but NEVER calls
 * runContainerApply, so refreshing mid-swap can't kick off a second one. No
 * active session → 404, same shape as the install attach.
 */
export async function attachServerContainerStream(c: Context) {
  const cloudGuard = assertNotCloud(c); if (cloudGuard) return cloudGuard;
  const { server } = await resolveServer(c);
  if (!server) return c.json({ error: "Server not found" }, 404);

  const component = parseComponent(c);
  if (!component) return c.json({ error: "Unknown component" }, 400);

  const session = getActiveContainerApplySession(server.id, component);
  if (!session) return c.json({ error: "No active session" }, 404);

  return streamSSE(c, async (sseStream) => {
    let closed = false;
    const writer = (event: string, data: string): boolean => {
      if (closed) return false;
      try {
        void sseStream.writeSSE({ event, data });
        return true;
      } catch {
        return false;
      }
    };

    const { success, unsubscribe } = subscribeContainerApplySession(session.id, writer);
    if (!success || session.status !== "running") return;

    await new Promise<void>((resolve) => {
      const iv = setInterval(() => {
        if (closed || session.status !== "running") {
          clearInterval(iv);
          resolve();
        }
      }, 1000);
      sseStream.onAbort(() => {
        closed = true;
        unsubscribe();
        clearInterval(iv);
        resolve();
      });
    });
  });
}
