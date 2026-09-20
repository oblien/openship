/** Managed container operations over retained detection, repair, and replay services. */
import { OperationError } from "@repo/contracts";
import { repos } from "@repo/db";
import type { ExecutionContext } from "../../../context";
import type { ServerDependencies } from "../../../servers";
import { subscriptionEvents } from "../../../event-stream";
import { authorization } from "../../lib/authorization";
import { audit, operationAuditContext } from "../../lib/audit-emitter";
import { assertSelfHosted, requireSelfHostedServer, assertServerExecution } from "./server-access";
import { applyAllContainers, scanOrgContainers, detectServerContainers, loadOrgContainerIssues, runContainerApply } from "./server-containers.service";
import { getActiveContainerApplySession, listContainerApplySessions, subscribeContainerApplySession } from "../../lib/server-container-session";

const SETTLED_WINDOW_MS = 90_000;

async function authorizedServer(ctx: ExecutionContext, id: string, action: "read" | "write") {
  const context = await authorization.authorize(ctx, { resourceType: "server", resourceId: id, action });
  const server = await requireSelfHostedServer(context, id);
  await assertServerExecution(server);
  return server;
}

function record(ctx: ExecutionContext, id: string, after?: Record<string, unknown>) {
  audit.recordAsync(operationAuditContext(ctx), { eventType: "server:write", resourceType: "server", resourceId: id, after });
}

export const serverContainerCollection: Pick<ServerDependencies["collection"],
  "listAllContainers" | "scanAllContainers" | "containersBehind" | "containerIssues" | "applyingContainers" | "applyAllContainers"
> = {
  async listAllContainers(ctx) { assertSelfHosted(); return groupedContainers(ctx.organizationId); },
  async scanAllContainers(ctx) {
    assertSelfHosted();
    await scanOrgContainers(ctx.organizationId, server => authorizedServer(ctx, server.id, "write").then(() => {}));
    const result = await groupedContainers(ctx.organizationId);
    record(ctx, "*");
    return result;
  },
  async containersBehind(ctx) {
    assertSelfHosted();
    const rows = await repos.serverContainerStatus.listBehindByOrg(ctx.organizationId);
    return { servers: new Set(rows.map(row => row.serverId)).size, components: rows.length };
  },
  async containerIssues(ctx) { assertSelfHosted(); return loadOrgContainerIssues(ctx.organizationId); },
  applyingContainers: listApplyingContainers,
  async applyAllContainers(ctx, input = {}) {
    assertSelfHosted();
    const result = await applyAllContainers(ctx.organizationId, input.intents,
      server => authorizedServer(ctx, server.id, "write").then(() => {}));
    record(ctx, "*", {
      intents: input.intents ?? ["update", "repair"],
      started: result.started.map(row => `${row.serverId}:${row.component}:${row.intent}`),
      skipped: result.skipped.map(row => `${row.serverId}:${row.component}:${row.reason}`),
    });
    return result;
  },
};

export const serverContainerResources: Pick<ServerDependencies["resources"], "listContainers" | "scanContainers" | "containerApplySession"> = {
  async listContainers(ctx, id) {
    await requireSelfHostedServer(ctx, id);
    return repos.serverContainerStatus.listByServer(id);
  },
  async scanContainers(ctx, id) {
    const server = await requireSelfHostedServer(ctx, id);
    await assertServerExecution(server);
    const containers = await detectServerContainers(server).catch((error: unknown) => { throw new Error(`scan failed: ${(error as Error).message}`); });
    record(ctx, id);
    return { ok: true, containers };
  },
  async containerApplySession(ctx, id, input) {
    await requireSelfHostedServer(ctx, id);
    const session = getActiveContainerApplySession(id, input.component);
    return session ? { active: true, sessionId: session.id, status: "running", serverId: session.serverId, component: session.component } : { active: false };
  },
};

export const serverContainerStreams: NonNullable<ServerDependencies["containers"]> = {
  async start(ctx, id, input, signal) {
    const server = await authorizedServer(ctx, id, "write");
    signal?.throwIfAborted();
    if (input.component === "mail" && !await repos.mailServer.get(id).catch(() => undefined))
      throw new OperationError("No mail server is provisioned on this server", 400, "MAIL_SERVER_NOT_PROVISIONED");
    const { session } = runContainerApply(server, input.component, input.intent ?? "update",
      () => authorizedServer(ctx, id, "write").then(() => {}));
    record(ctx, id);
    // A disconnected observer does not cancel an accepted container swap.
    return subscriptionEvents(writer => subscribeContainerApplySession(session.id, writer), signal);
  },
  async events(ctx, id, input, signal) {
    await requireSelfHostedServer(ctx, id);
    signal?.throwIfAborted();
    const session = getActiveContainerApplySession(id, input.component);
    if (!session) throw new OperationError("No active session", 404, "NOT_FOUND");
    return subscriptionEvents(writer => subscribeContainerApplySession(session.id, writer), signal);
  },
};

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

export async function listApplyingContainers(ctx: ExecutionContext) {
  assertSelfHosted();
  const [servers, rows] = await Promise.all([
    repos.server.listByOrganization(ctx.organizationId),
    repos.serverContainerStatus.listByOrg(ctx.organizationId),
  ]);
  const names = new Map(servers.map((s) => [s.id, s.name ?? s.sshHost]));
  const sessions = listContainerApplySessions({ settledWithinMs: SETTLED_WINDOW_MS }).filter((s) =>
    names.has(s.serverId),
  );
  const running = new Map(
    sessions.filter((s) => s.status === "running").map((s) => [`${s.serverId}:${s.component}`, s]),
  );
  const rowFor = new Map(rows.map((r) => [`${r.serverId}:${r.component}`, r]));

  // Flagged rows first (stable, and the only source that knows the intent), then any
  // running session whose row went missing — a swap mid-flight is still in flight
  // even if its cached row was dropped.
  const active = [
    ...rows
      .filter((r) => r.latestInProgress)
      .map((r) => {
        const key = `${r.serverId}:${r.component}`;
        const session = running.get(key);
        return {
          serverId: r.serverId,
          serverName: names.get(r.serverId) ?? r.serverId,
          component: r.component,
          state: session ? ("running" as const) : ("queued" as const),
          intent: r.behind ? ("update" as const) : ("repair" as const),
          ...(session
            ? { sessionId: session.id, steps: session.steps, startedAt: new Date(session.startedAt).toISOString() }
            : {}),
        };
      }),
    ...[...running.entries()]
      .filter(([key]) => !rowFor.get(key)?.latestInProgress)
      .map(([, session]) => ({
        serverId: session.serverId,
        serverName: names.get(session.serverId) ?? session.serverId,
        component: session.component,
        state: "running" as const,
        intent: null,
        sessionId: session.id,
        steps: session.steps,
        startedAt: new Date(session.startedAt).toISOString(),
      })),
  ];

  const recent = sessions
    .filter((s) => s.status !== "running")
    .map((s) => ({
      serverId: s.serverId,
      serverName: names.get(s.serverId) ?? s.serverId,
      component: s.component,
      ok: s.status === "completed",
      ...(s.error ? { error: s.error } : {}),
      finishedAt: new Date(s.finishedAt ?? Date.now()).toISOString(),
    }));

  return { active, recent };
}
