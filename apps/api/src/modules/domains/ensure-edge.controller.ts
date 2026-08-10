/**
 * Project-scoped "ensure edge (+ apply routes)" — the SECOND trigger for the one
 * port-80/443 takeover-consent flow (the first is the deploy pipeline). Reuses
 * the exact engine (`ensureEdge` → `ensureEdgeClear` → `runEdgeTakeover`) and the
 * generic prompt transport, so the SAME consent modal appears — but WITHOUT a
 * container redeploy: it installs/owns the edge on the project's server, then
 * re-applies the project's routes reload-free via `applyProjectRouting`.
 *
 * Used by the Domains tab (first route / "set up edge") instead of forcing a
 * full deploy — which matters for migrated attach-live stacks whose containers
 * must not be recreated.
 */

import type { Context } from "hono";
import { repos } from "@repo/db";
import { safeErrorMessage } from "@repo/core";
import {
  ensureEdge,
  probeEdge,
  ourEdgeContainerRunning,
  recoverInterruptedTakeover,
  COMPONENT_INSTALLERS,
  type PromptUserFn,
  type CommandExecutor,
} from "@repo/adapters";
import { getRequestContext } from "../../lib/request-context";
import { resolveDeploymentRuntime } from "../../lib/deployment-runtime";
import { ensureEdgeChallengeReady } from "../../lib/edge-challenge";
import { permission } from "../../lib/permission";
import { param } from "../../lib/controller-helpers";
import { streamSSE } from "../../lib/sse";
import { sshManager } from "../../lib/ssh-manager";
import { pinnedEdgeImage, withPinnedEdgeImage } from "../../lib/edge-image";
import { deliverManagedImage } from "../../lib/deliver-managed-image";
import { resolveAcmeProviderOptions } from "../../lib/acme-config";
import { applyProjectRouting } from "./routing-apply.service";
import {
  createEdgeConsentSession,
  getEdgeConsentSession,
  getActiveEdgeSessionForProject,
  appendEdgeLog,
  promptEdgeUser,
  respondToEdgePrompt,
  finishEdgeConsentSession,
  subscribeEdgeConsentSession,
} from "./edge-consent-session";

/**
 * Run `fn` with an executor that reaches the box the edge lives on. The
 * auto-registered "This Server" (server-host mode) is `isLocal` with NO sshHost,
 * so `sshManager` can't connect to it — that's what made "Preparing the server's
 * edge…" hang forever. Resolve `createHostExecutor()` (the local host — SSH-to-
 * host when the API is containerized) for it, and the pooled SSH executor for a
 * real remote server. Works identically for a bare edge and the docker edge.
 */
async function withEdgeExecutor<T>(
  serverId: string,
  organizationId: string,
  fn: (exec: CommandExecutor) => Promise<T>,
): Promise<T> {
  // No local/remote branch: `acquire` already returns the pooled HOST channel for a
  // local row (and never dials its display sshHost). Branching here to a fresh
  // `createHostExecutor()` is what leaked a connection per poll of this endpoint —
  // the dashboard calls edgeStatus on a timer (#291).
  return sshManager.withExecutor(serverId, fn);
}

/** True when the server is the auto-registered local host (reachable via the
 *  host executor, not SSH — so no `probeReachable` dial). */
async function isLocalHostServer(serverId: string, organizationId: string): Promise<boolean> {
  const server = await repos.server.getInOrganization(serverId, organizationId).catch(() => null);
  return Boolean(server?.isLocal);
}

/** Resolve the server a project's active deployment runs on (self-hosted only). */
export async function resolveProjectServer(
  projectId: string,
  organizationId: string,
): Promise<{ project: NonNullable<Awaited<ReturnType<typeof repos.project.findById>>>; serverId: string } | { error: string; status: 400 | 404 }> {
  const project = await repos.project.findById(projectId);
  if (!project || project.organizationId !== organizationId) return { error: "Project not found", status: 404 };
  if (project.cloudWorkspaceId) {
    return { error: "Cloud projects manage routing at the edge automatically", status: 400 };
  }
  if (!project.activeDeploymentId) return { error: "Deploy the project before setting up its edge", status: 400 };
  // Prefer the durable binding; fall back to the active deployment's snapshot for
  // legacy rows not yet backfilled.
  const dep = await repos.deployment.findById(project.activeDeploymentId);
  const serverId = project.serverId ?? (dep?.meta as { serverId?: string } | null)?.serverId;
  if (!serverId) return { error: "Project is not deployed to a server", status: 400 };
  return { project, serverId };
}

/**
 * GET /projects/:id/routing/edge-status  (read-only)
 *
 * Reports whether the project's server edge (OpenResty on 80/443) is already
 * ours — so the Domains tab can show "Edge ready" instead of always offering
 * "Set up edge". Reuses the read-only `probeEdge` classifier. Never mutates.
 *
 * SEC1 rule: a `probeReachable` fast-fail keeps an offline/blocked box from
 * hanging the tab; the probe itself runs through `withExecutor` (executor
 * middleware), never a raw blocking SSH read.
 */
export async function edgeStatus(c: Context) {
  const id = param(c, "id");
  const ctx = getRequestContext(c);
  await permission.assert(ctx, { resourceType: "project", resourceId: id, action: "read" });

  const project = await repos.project.findById(id);
  if (!project || project.organizationId !== ctx.organizationId) {
    return c.json({ error: "Project not found" }, 404);
  }
  // Cloud manages its own ingress — always "ready", nothing to set up.
  if (project.cloudWorkspaceId) {
    return c.json({ ready: true, managed: "cloud" as const });
  }

  const resolved = await resolveProjectServer(id, ctx.organizationId);
  // Not deployed / no server yet — surface a reason (200, not an error) so the
  // UI renders guidance rather than a failure.
  if ("error" in resolved) {
    return c.json({ ready: false, reachable: null, reason: resolved.error });
  }
  const { serverId } = resolved;

  // Fast-fail if the box is offline — but ONLY dial SSH for a real remote server.
  // The local host-server has no sshHost (probeReachable would falsely report it
  // offline); it's always reachable through createHostExecutor.
  const local = await isLocalHostServer(serverId, ctx.organizationId);
  if (!local) {
    const reachable = await sshManager.probeReachable(serverId).catch(() => false);
    if (!reachable) {
      return c.json({ ready: false, reachable: false });
    }
  }

  try {
    // Readiness = "is OUR edge container running", the SAME fact the server
    // Infrastructure tab (detectEdgeContainer.running) and System Health
    // (resolveOurEdgeContainer) key on. probeEdge stays for the takeover preview
    // (classification/occupants/canProceedClean), but its `classification==="ours"`
    // also credits a bare-host OpenResty leftover as ours even when the container
    // is stopped — which is why the pill said "ready" while the server tab said
    // "down". The edge is container-only now, so the container is the truth.
    const { status, containerRunning } = await withEdgeExecutor(
      serverId,
      ctx.organizationId,
      async (executor) => ({
        status: await probeEdge(executor),
        containerRunning: await ourEdgeContainerRunning(executor),
      }),
    );
    return c.json({
      ready: containerRunning,
      reachable: true,
      classification: status.classification,
      canProceedClean: status.canProceedClean,
      occupants: status.occupants.map((o) => ({
        port: o.port,
        proxy: o.proxy ?? null,
        label: o.command ?? null,
      })),
    });
  } catch (err) {
    // A probe failure shouldn't 500 the tab — report unknown so the button
    // falls back to "Set up edge".
    return c.json({ ready: false, reachable: true, error: safeErrorMessage(err) });
  }
}

/**
 * POST /projects/:id/routing/ensure-edge/stream  (SSE)
 *
 * Streams `session` / `log` / `prompt` / `complete` / `end` events. On a foreign
 * proxy holding 80/443 it blocks on a `prompt` (migrate / take over / cancel),
 * answered out-of-band by `.../respond`.
 */
export async function ensureEdgeStream(c: Context) {
  const id = param(c, "id");
  const ctx = getRequestContext(c);
  await permission.assert(ctx, { resourceType: "project", resourceId: id, action: "write" });

  const resolved = await resolveProjectServer(id, ctx.organizationId);
  if ("error" in resolved) return c.json({ error: resolved.error }, resolved.status);
  const { serverId } = resolved;

  const existing = getActiveEdgeSessionForProject(id);
  if (existing) return c.json({ error: "edge_in_progress", sessionId: existing.id }, 409);

  const session = createEdgeConsentSession(id);

  return streamSSE(c, async (sse) => {
    let closed = false;
    const writer = (event: string, data: string): boolean => {
      if (closed) return false;
      try {
        void sse.writeSSE({ event, data });
        return true;
      } catch {
        return false;
      }
    };
    const { unsubscribe } = subscribeEdgeConsentSession(session.id, writer);
    // The client needs the session id to answer a prompt via /respond.
    writer("session", JSON.stringify({ type: "session", sessionId: session.id }));

    const onLog = (l: { message: string; level: "info" | "warn" | "error" }) =>
      appendEdgeLog(session.id, l.message, l.level);
    const promptUser: PromptUserFn = (p) => promptEdgeUser(session.id, p);

    try {
      appendEdgeLog(session.id, "Checking the server's edge (ports 80/443)…");
      appendEdgeLog(session.id, "Connecting to the server…");
      await withEdgeExecutor(serverId, ctx.organizationId, async (executor) => {
        // No extra probe here: the installer (`ensureEdgeClear` inside
        // `installContainerEdge`) detects the edge state itself and raises the
        // takeover consent, and the image pull streams live via `onLog` — so the
        // console stays alive without a duplicate round-trip.
        // Self-heal a takeover that crashed mid-flight on a prior attempt.
        await recoverInterruptedTakeover(executor, onLog).catch(() => {});
        // Stage-B APPLY, ahead of the installer: build the edge from our source on
        // the control plane and ship it to this box, so the create path below adopts
        // the dev image instead of pulling `ghcr.io/oblien/openship-edge:<version>`
        // (the reported bug). No-op in prod — no checkout → deliver returns at once.
        await deliverManagedImage({
          kind: "edge",
          image: pinnedEdgeImage(),
          targetExecutor: executor,
          onLog,
        });
        const installer = COMPONENT_INSTALLERS["edge"];
        // Same call shape as the deploy pipeline + server-setup: the installer
        // raises the edge-conflict consent via promptUser; on "migrate",
        // ensureEdge runs the takeover (bring up our edge + migrate the foreign
        // proxy's sites). No app container is touched.
        const edge = await ensureEdge(
          executor,
          (p) => installer(executor, onLog, withPinnedEdgeImage({ promptUser: p })),
          { promptUser, onLog, nginx: resolveAcmeProviderOptions() },
        );
        if (edge.migrated && !edge.ok) {
          throw new Error("Edge takeover failed — rolled back to the previous proxy.");
        }
      });

      appendEdgeLog(session.id, "Edge ready — applying routes…");
      // Prepare the box to answer Openship Cloud's target check while we're already
      // here. Doing it at edge-setup (not when a free domain is added) is what makes
      // a later free domain work without a redeploy — and it can't be deferred to the
      // baked image's catch-all, which never reaches an edge on an older image.
      //
      // Routing is resolved from the DEPLOYMENT, not `platform()`: the edge we just
      // prepared may live on a remote server, and the local orchestrator's provider
      // would write the vhost to the wrong box.
      await (async () => {
        const dep = await repos.deployment.findById(resolved.project.activeDeploymentId!);
        if (!dep) return;
        const { routing } = await resolveDeploymentRuntime(dep);
        await ensureEdgeChallengeReady(ctx.organizationId, routing, {
          serverId,
          onLog: (m) => appendEdgeLog(session.id, m.trim(), "warn"),
        });
      })().catch(() => {});
      await applyProjectRouting(id).catch((e) =>
        appendEdgeLog(session.id, `Route apply warning: ${safeErrorMessage(e)}`, "warn"),
      );
      appendEdgeLog(session.id, "Done — routes are live.");
      finishEdgeConsentSession(session.id, "completed");
    } catch (err) {
      appendEdgeLog(session.id, safeErrorMessage(err), "error");
      finishEdgeConsentSession(session.id, "failed");
    } finally {
      closed = true;
      unsubscribe();
    }
  });
}

/** POST /projects/:id/routing/ensure-edge/respond  { sessionId, action } */
export async function ensureEdgeRespond(c: Context) {
  const id = param(c, "id");
  const ctx = getRequestContext(c);
  await permission.assert(ctx, { resourceType: "project", resourceId: id, action: "write" });

  const { sessionId, action } = await c.req.json<{ sessionId?: string; action?: string }>();
  if (!sessionId || !action) return c.json({ error: "sessionId and action are required" }, 400);
  const session = getEdgeConsentSession(sessionId);
  if (!session || session.projectId !== id) return c.json({ error: "Session not found" }, 404);
  return c.json({ ok: respondToEdgePrompt(sessionId, action) });
}
