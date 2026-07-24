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
  recoverInterruptedTakeover,
  COMPONENT_INSTALLERS,
  type PromptUserFn,
} from "@repo/adapters";
import { getRequestContext } from "../../lib/request-context";
import { permission } from "../../lib/permission";
import { param } from "../../lib/controller-helpers";
import { streamSSE } from "../../lib/sse";
import { sshManager } from "../../lib/ssh-manager";
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

/** Resolve the server a project's active deployment runs on (self-hosted only). */
async function resolveProjectServer(
  projectId: string,
  organizationId: string,
): Promise<{ project: NonNullable<Awaited<ReturnType<typeof repos.project.findById>>>; serverId: string } | { error: string; status: 400 | 404 }> {
  const project = await repos.project.findById(projectId);
  if (!project || project.organizationId !== organizationId) return { error: "Project not found", status: 404 };
  if (project.cloudWorkspaceId) {
    return { error: "Cloud projects manage routing at the edge automatically", status: 400 };
  }
  if (!project.activeDeploymentId) return { error: "Deploy the project before setting up its edge", status: 400 };
  const dep = await repos.deployment.findById(project.activeDeploymentId);
  const serverId = (dep?.meta as { serverId?: string } | null)?.serverId;
  if (!serverId) return { error: "Project is not deployed to a server", status: 400 };
  return { project, serverId };
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
      await sshManager.withExecutor(serverId, async (executor) => {
        // Self-heal a takeover that crashed mid-flight on a prior attempt.
        await recoverInterruptedTakeover(executor, onLog).catch(() => {});
        const installer = COMPONENT_INSTALLERS["openresty"];
        // Same call shape as the deploy pipeline + server-setup: the installer
        // raises the edge-conflict consent via promptUser; on "migrate",
        // ensureEdge runs the takeover (install OpenResty + migrate the foreign
        // proxy's sites). No app container is touched.
        const edge = await ensureEdge(
          executor,
          (p) => installer(executor, onLog, { promptUser: p }),
          { promptUser, onLog },
        );
        if (edge.migrated && !edge.ok) {
          throw new Error("Edge takeover failed — rolled back to the previous proxy.");
        }
      });

      appendEdgeLog(session.id, "Edge ready — applying routes…");
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
