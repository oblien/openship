/**
 * Project-scoped "ensure edge (+ apply routes)" — the SECOND trigger for the one
 * port-80/443 takeover-consent flow (the first is the deploy pipeline). Reuses
 * the exact engine (`ensureEdge` → `ensureEdgeClear` → `runEdgeTakeover`) and the
 * generic prompt transport, so the SAME consent modal appears — but WITHOUT a
 * container redeploy: it installs/owns the edge on the project's server, then
 * re-applies the project's routes reload-free via `reapplyProjectLiveRoutes`
 * (the per-domain surface) + `applyProjectRouting` (the composite/fan-out overlay).
 *
 * Used by the Domains tab (first route / "set up edge") instead of forcing a
 * full deploy — which matters for migrated attach-live stacks whose containers
 * must not be recreated.
 */

import { reportCaughtError as observeCaughtError } from "@repo/core/diagnostics";
import type { Context } from "hono";
import { safeErrorMessage } from "@repo/core";
import { probeEdge, ourEdgeContainerRunning, type PromptUserFn } from "@repo/adapters";
import { getRequestContext } from "../../lib/request-context";
import { permission } from "../../lib/permission";
import { param } from "../../lib/controller-helpers";
import { streamSSE } from "../../lib/sse";
import { sshManager } from "@repo/platform/engine/lib/ssh-manager";
import { prepareServerEdge, applyProjectEdgeRoutes, resolveProjectServer } from "@repo/platform/engine/modules/domains/project-edge.service";
export { resolveProjectServer } from "@repo/platform/engine/modules/domains/project-edge.service";
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

  const resolved = await resolveProjectServer(id, ctx.organizationId);
  // Cloud manages its own ingress — always "ready", nothing to set up. This
  // marker comes from the canonical ACTIVE-deployment target, not the mutable
  // destination selected for a future deployment.
  if ("error" in resolved && resolved.managed === "cloud") {
    return c.json({ ready: true, managed: "cloud" as const });
  }
  // Not deployed / no server yet — surface a reason (200, not an error) so the
  // UI renders guidance rather than a failure.
  if ("error" in resolved) {
    return c.json({ ready: false, reachable: null, reason: resolved.error });
  }
  const { serverId, isLocal } = resolved;

  // Fast-fail if the box is offline — but ONLY dial SSH for a real remote server.
  // The local host-server has no sshHost (probeReachable would falsely report it
  // offline); it's always reachable through createHostExecutor.
  if (!isLocal) {
    const reachable = await sshManager.probeReachable(serverId).catch((diagnosticFailure) => { observeCaughtError(diagnosticFailure, "api/modules/domains/ensure-edge.controller"); return false; });
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
    const { status, containerRunning } = await sshManager.withExecutor(serverId, async (executor) => ({
      status: await probeEdge(executor),
      containerRunning: await ourEdgeContainerRunning(executor),
    }));
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
    observeCaughtError(err, "api/modules/domains/ensure-edge.controller");
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
      } catch (diagnosticFailure) {
        observeCaughtError(diagnosticFailure, "api/modules/domains/ensure-edge.controller");
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
      await prepareServerEdge(serverId, ctx.organizationId, { onLog, promptUser, projectId: id });
      appendEdgeLog(session.id, "Edge ready — applying routes…");
      const routeWarnings = await applyProjectEdgeRoutes(ctx, id, {
        onLog: (message, level) => appendEdgeLog(session.id, message, level),
      });
      appendEdgeLog(
        session.id,
        routeWarnings.length > 0
          ? "Edge setup finished with route warnings. Review the messages above."
          : "Edge setup and route application finished.",
        routeWarnings.length > 0 ? "warn" : "info",
      );
      finishEdgeConsentSession(session.id, routeWarnings.length > 0 ? "failed" : "completed");
    } catch (err) {
      observeCaughtError(err, "api/modules/domains/ensure-edge.controller");
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
