/**
 * Deployment controller - Hono request handlers.
 */

import type { Context } from "hono";
import { AppError } from "@repo/core";
import { streamSSE } from "../../lib/sse";
import { param } from "../../lib/controller-helpers";
import { getRequestContext } from "../../lib/request-context";
import { permission } from "../../lib/permission";
import * as deploymentService from "./deployment.service";
import { triggerReconcile } from "./reconcile.service";
import * as buildService from "./build.service";
import * as buildStatusService from "./build-status.service";
import * as sslService from "./ssl.service";
import * as prepareService from "./prepare.service";
import { maybeProxyCloudProject, proxyToSaaS } from "../../lib/cloud/project-router";
import { promoteProjectToCloud, TransferConflictError } from "../projects/transfer.service";
import { env } from "../../config";

export async function list(c: Context) {
  const ctx = getRequestContext(c);
  const projectId = c.req.query("projectId");
  const environment = c.req.query("environment");
  const page = Number(c.req.query("page") ?? 1);
  const perPage = Number(c.req.query("perPage") ?? 50);

  const result = await deploymentService.listDeployments(ctx.organizationId, {
    projectId: projectId ?? undefined,
    environment: environment ?? undefined,
    page,
    perPage,
  });

  return c.json({
    success: true,
    data: result.rows,
    total: result.total,
    page: result.page,
    perPage: result.perPage,
  });
}

export async function create(c: Context) {
  const ctx = getRequestContext(c);
  const body = await c.req.json<{
    projectId: string;
    branch?: string;
    commitSha?: string;
    environment?: string;
    /** Force-rebuild every enabled service. Skips smart per-service routing. */
    forceAll?: boolean;
    /** Smart per-service target list. Mutually exclusive with forceAll. */
    serviceIds?: string[];
    /** Manual smart redeploy: rebuild only services changed since the active deploy. */
    smartRoute?: boolean;
    /** Refresh: re-apply current env to the active deploy — no git pull, no rebuild. */
    refresh?: boolean;
    /** Auto-deploy marker from the webhook forward. Only "webhook" is honored
     *  (sanitized below) so it can't spoof trigger provenance. */
    trigger?: string;
  }>();
  if (body.projectId) {
    await permission.assert(getRequestContext(c), { resourceType: "project", resourceId: body.projectId, action: "write" });
    // Cloud-as-source: a cloud project's deploy runs on the SaaS; proxy it as
    // the org owner. The local box does zero orchestration for cloud projects.
    const proxied = await maybeProxyCloudProject(c, body.projectId, getRequestContext(c).organizationId, {
      body: JSON.stringify(body),
    });
    if (proxied) return proxied;
  }
  // Construct the triggerDeployment arg from an explicit ALLOWLIST — never
  // forward the raw body. triggerDeployment has internal-only fields
  // (reuseSnapshot, rollbackStrategy, commitShaBefore) that must NOT be
  // settable over HTTP: reuseSnapshot ships a frozen, un-normalized build
  // snapshot verbatim (commands/target/runtimeMode), so leaking it would let a
  // caller inject arbitrary build config. Those fields are only ever set by the
  // internal rollback/webhook callers.
  const result = await buildService.triggerDeployment(ctx, {
    projectId: body.projectId,
    branch: body.branch,
    commitSha: body.commitSha,
    environment: body.environment,
    forceAll: body.forceAll,
    serviceIds: body.serviceIds,
    smartRoute: body.smartRoute,
    refresh: body.refresh,
    trigger: body.trigger === "webhook" ? "webhook" : undefined,
  });
  // Flatten `deployment` into the `{ deployment_id, project_id }` contract the
  // CLI and dashboard read (see apps/cli deploy.ts, dashboard api/updates.ts).
  // Additive: `deployment` (and `skipped`) stay so existing readers of those
  // keep working.
  return c.json(
    {
      data: {
        ...result,
        deployment_id: result.deployment.id,
        project_id: result.deployment.projectId,
      },
    },
    202,
  );
}

export async function getById(c: Context) {
  const ctx = getRequestContext(c);
  const id = param(c, "id");
  await permission.assert(getRequestContext(c), { resourceType: "deployment", resourceId: id, action: "read" });
  const dep = await deploymentService.getDeployment(id, ctx.organizationId);
  // On-demand reconcile: opening a `reconciling` deployment kicks off a
  // verification against the live host (deduped, fire-and-forget). The current
  // row is returned as-is; the resolved status arrives via the next poll/SSE.
  if (dep?.status === "reconciling") triggerReconcile(id);
  return c.json({ data: dep });
}

export async function logs(c: Context) {
  const ctx = getRequestContext(c);
  const id = param(c, "id");
  await permission.assert(getRequestContext(c), { resourceType: "deployment", resourceId: id, action: "read" });
  const tail = c.req.query("tail") ? Number(c.req.query("tail")) : undefined;
  const logEntries = await deploymentService.getDeploymentLogs(id, ctx.organizationId, tail);
  return c.json({ data: logEntries });
}

/**
 * Shared SSE streaming helper - subscribes to a build session and
 * keeps the connection open until the client disconnects or session ends.
 */
function streamBuildSession(
  c: Context,
  deploymentId: string,
  initialEvent?: { event: string; data: string },
  sinceSeq?: number,
) {
  return streamSSE(c, async (sseStream) => {
    let closed = false;

    if (initialEvent) {
      await sseStream.writeSSE(initialEvent);
    }

    const writer = (event: string, data: string): boolean => {
      if (closed) return false;
      try {
        void sseStream.writeSSE({ event, data });
        return true;
      } catch {
        return false;
      }
    };

    // `sinceSeq` (from the client's history snapshot) makes the session replay
    // ONLY entries newer than what the client already has — the live stream
    // stops re-delivering history on refresh/reconnect.
    const { success, unsubscribe } = buildService.subscribeToBuildSession(deploymentId, writer, sinceSeq);

    if (!success) {
      await sseStream.writeSSE({ event: "error", data: JSON.stringify({ error: "Session not found" }) });
      return;
    }

    await new Promise<void>((resolve) => {
      const checkInterval = setInterval(() => {
        if (closed) {
          clearInterval(checkInterval);
          resolve();
        }
      }, 1000);

      sseStream.onAbort(() => {
        closed = true;
        unsubscribe();
        clearInterval(checkInterval);
        resolve();
      });
    });
  });
}

export async function stream(c: Context) {
  const ctx = getRequestContext(c);
  const id = param(c, "id");
  await permission.assert(getRequestContext(c), { resourceType: "deployment", resourceId: id, action: "read" });
  // Verify the requesting user owns this deployment before streaming
  await deploymentService.getDeployment(id, ctx.organizationId);
  // Resume cursor: explicit ?since= (the client's history-snapshot max seq),
  // falling back to the EventSource Last-Event-ID header on native reconnect.
  const sinceRaw = c.req.query("since") ?? c.req.header("Last-Event-ID");
  const sinceSeq = sinceRaw != null && sinceRaw !== "" ? Number(sinceRaw) : undefined;
  return streamBuildSession(c, id, undefined, Number.isFinite(sinceSeq) ? sinceSeq : undefined);
}

export async function rollback(c: Context) {
  const ctx = getRequestContext(c);
  const id = param(c, "id");
  await permission.assert(getRequestContext(c), { resourceType: "deployment", resourceId: id, action: "admin" });
  // GitHub access gate: a git-strategy rollback re-clones the repo, so a
  // member must be granted it (default-deny). Owner passes.
  await deploymentService.assertGitHubAccessForDeployment(ctx, id, ctx.organizationId);
  const dep = await deploymentService.rollbackDeployment(id, ctx.organizationId);
  return c.json({ data: dep });
}

export async function pin(c: Context) {
  const ctx = getRequestContext(c);
  const id = param(c, "id");
  await permission.assert(getRequestContext(c), { resourceType: "deployment", resourceId: id, action: "write" });
  const body = await c.req
    .json<{ pinned?: boolean }>()
    .catch(() => ({} as { pinned?: boolean }));
  const pinned = body.pinned !== false; // default true on POST
  const dep = await deploymentService.setDeploymentPin(id, ctx.organizationId, pinned);
  return c.json({ data: dep });
}

export async function reject(c: Context) {
  const ctx = getRequestContext(c);
  const id = param(c, "id");
  await permission.assert(getRequestContext(c), { resourceType: "deployment", resourceId: id, action: "write" });
  try {
    const result = await deploymentService.rejectDeployment(id, ctx.organizationId);
    return c.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to reject deployment";
    return c.json({ success: false, error: message }, 400);
  }
}

export async function keep(c: Context) {
  const ctx = getRequestContext(c);
  const id = param(c, "id");
  await permission.assert(getRequestContext(c), { resourceType: "deployment", resourceId: id, action: "write" });
  try {
    const result = await deploymentService.keepDeployment(id, ctx.organizationId);
    return c.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to keep deployment";
    return c.json({ success: false, error: message }, 400);
  }
}

export async function skipPortCheck(c: Context) {
  const ctx = getRequestContext(c);
  const id = param(c, "id");
  await permission.assert(getRequestContext(c), { resourceType: "deployment", resourceId: id, action: "write" });
  const body = await c.req.json<{ target?: number | string }>().catch(() => ({}) as { target?: number | string });
  if (body.target === undefined) {
    return c.json({ success: false, error: "Missing 'target' (port or service id)" }, 400);
  }
  try {
    const result = await deploymentService.skipPortCheck(id, ctx.organizationId, body.target);
    return c.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to skip port check";
    return c.json({ success: false, error: message }, 400);
  }
}

export async function cancel(c: Context) {
  const ctx = getRequestContext(c);
  const id = param(c, "id");
  await permission.assert(getRequestContext(c), { resourceType: "deployment", resourceId: id, action: "admin" });
  try {
    const result = await buildService.cancelBuildSession(id);
    return c.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to cancel deployment";
    return c.json({ success: false, error: message }, 400);
  }
}

export async function remove(c: Context) {
  const ctx = getRequestContext(c);
  const id = param(c, "id");
  await permission.assert(getRequestContext(c), { resourceType: "deployment", resourceId: id, action: "admin" });
  try {
    await deploymentService.deleteDeployment(id, ctx.organizationId);
    return c.json({ success: true, message: "Deployment deleted" });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to delete deployment";
    return c.json({ success: false, error: message }, 400);
  }
}

export async function restart(c: Context) {
  const ctx = getRequestContext(c);
  const id = param(c, "id");
  await permission.assert(getRequestContext(c), { resourceType: "deployment", resourceId: id, action: "write" });
  const dep = await deploymentService.restartDeployment(id, ctx.organizationId);
  return c.json({ data: dep });
}

export async function containerInfo(c: Context) {
  const ctx = getRequestContext(c);
  const id = param(c, "id");
  await permission.assert(getRequestContext(c), { resourceType: "deployment", resourceId: id, action: "read" });
  const info = await deploymentService.getContainerInfo(id, ctx.organizationId);
  return c.json({ data: info });
}

export async function containerUsage(c: Context) {
  const ctx = getRequestContext(c);
  const id = param(c, "id");
  await permission.assert(getRequestContext(c), { resourceType: "deployment", resourceId: id, action: "read" });
  const usage = await deploymentService.getContainerUsage(id, ctx.organizationId);
  return c.json({ data: usage });
}

export async function buildRespond(c: Context) {
  const ctx = getRequestContext(c);
  const id = param(c, "id");
  await permission.assert(getRequestContext(c), { resourceType: "deployment", resourceId: id, action: "write" });
  const body = await c.req.json<{ action: string }>();
  if (!body.action) return c.json({ success: false, error: "Missing action" }, 400);
  const result = await buildService.respondToPrompt(id, body.action);
  return c.json({ success: result });
}

/**
 * POST /deployments/prepare - resolve project info from GitHub or local path.
 *
 * Body (GitHub): { source: "github", owner, repo, branch? }
 * Body (local):  { source: "local", path: "/abs/path" }
 * Callers may omit `source` and send { owner, repo }; treated as GitHub.
 */
export async function prepare(c: Context) {
  const ctx = getRequestContext(c);
  const body = await c.req.json<{
    source?: "github" | "local";
    owner?: string;
    repo?: string;
    branch?: string;
    path?: string;
  }>();

  // Determine source - callers may send { owner, repo } without an explicit source
  const source = body.source ?? (body.owner && body.repo ? "github" : undefined);

  try {
    let input: prepareService.Source;

    if (source === "github") {
      if (!body.owner || !body.repo) {
        return c.json({ error: "owner and repo are required" }, 400);
      }
      input = { source: "github", owner: body.owner, repo: body.repo, branch: body.branch, ctx };
    } else if (source === "local") {
      if (env.CLOUD_MODE) {
        return c.json({ error: "Local projects are not available in cloud mode" }, 403);
      }
      if (!body.path) {
        return c.json({ error: "path is required" }, 400);
      }
      input = { source: "local", path: body.path };
    } else {
      return c.json({ error: "source must be 'github' or 'local'" }, 400);
    }

    const info = await prepareService.resolveProjectInfo(input);
    return c.json(info);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to initialize deploy";
    return c.json({ error: message }, 400);
  }
}

export async function buildAccess(c: Context) {
  const ctx = getRequestContext(c);
  const body = await c.req.json<buildService.BuildAccessInput>();

  if (!body.projectId) {
    return c.json({ success: false, message: "projectId is required" }, 400);
  }

  await permission.assert(getRequestContext(c), { resourceType: "project", resourceId: body.projectId, action: "write" });

  // Cloud-as-source: an already-cloud project's build/deploy runs on the SaaS —
  // proxy it as the org owner; the local box does no orchestration.
  const proxied = await maybeProxyCloudProject(c, body.projectId, getRequestContext(c).organizationId, {
    body: JSON.stringify(body),
  });
  if (proxied) return proxied;

  // Born-on-cloud (SELF-HOSTED ONLY): a LOCAL project chosen for a CLOUD deploy
  // is promoted to the SaaS FIRST (ingest + local teardown), so it never exists
  // as a "local project using cloud pages/compute" hybrid — then the deploy
  // proxies and runs entirely on the SaaS. Promote throws BEFORE any local
  // teardown if the SaaS ingest fails, so the local project is left intact.
  //
  // EXCEPTION — local build: when the operator chose "Build on this machine",
  // we deliberately KEEP the project local-canonical and orchestrate the cloud
  // deploy from here (build locally with the host's credentials, upload the
  // output to an Openship Cloud workspace, deploy it). No promote/transfer, so
  // no duplicate/leftover cloud copy, and redeploys re-run this same local
  // pipeline. That path falls through to requestBuildAccess below, where
  // resolveEffectiveTarget keeps the cloud target for a local build.
  //
  // On the SaaS itself (CLOUD_MODE) there is NOTHING to promote — the project is
  // already canonical here — so skip and let the deploy run natively below.
  if (!env.CLOUD_MODE && body.deployTarget === "cloud" && body.buildStrategy !== "local") {
    try {
      await promoteProjectToCloud(getRequestContext(c), body.projectId);
    } catch (err) {
      if (err instanceof AppError) throw err;
      // A leftover cloud copy of this project (drift): surface a typed 409 with
      // a clear message. Cleanup is an explicit, runtime-aware operation (the
      // teardown endpoint) — never a deploy-triggered auto-delete of cloud data.
      if (err instanceof TransferConflictError) {
        // A slug/name conflict (a DIFFERENT cloud project owns the name) is not
        // a leftover copy — tell the operator to rename, not to "clean up".
        if (err.conflictKind === "slug") {
          return c.json(
            {
              success: false,
              code: "CLOUD_SLUG_TAKEN",
              message: `The name "${err.conflictValue}" is already taken on Openship Cloud. Rename this project and try again.`,
            },
            409,
          );
        }
        // A leftover cloud copy of THIS project (id) from an earlier transfer.
        return c.json(
          {
            success: false,
            code: "CLOUD_PROMOTE_CONFLICT",
            message:
              "This project already has a copy on Openship Cloud (leftover from an earlier transfer). Clean it up and retry to promote this local copy.",
          },
          409,
        );
      }
      const message =
        err instanceof Error ? err.message : "Failed to move project to Openship Cloud";
      return c.json({ success: false, message }, 400);
    }
    return proxyToSaaS(c, getRequestContext(c).organizationId, { body: JSON.stringify(body) });
  }

  try {
    const result = await buildService.requestBuildAccess(ctx, body);
    return c.json(result);
  } catch (err) {
    // Preserve AppError code so the dashboard can branch on preflight
    // failures (CLOUD_REQUIRED_*, GITHUB_REMOTE_TOKEN_REQUIRED, …).
    // The global error-handler middleware serializes AppError as
    // `{ error, code }` with the right statusCode.
    if (err instanceof AppError) throw err;
    const message = err instanceof Error ? err.message : "Failed to start deployment";
    return c.json({ success: false, message }, 400);
  }
}

export async function buildStatus(c: Context) {
  const ctx = getRequestContext(c);
  const id = param(c, "id");
  await permission.assert(getRequestContext(c), { resourceType: "deployment", resourceId: id, action: "read" });

  try {
    const result = await buildStatusService.getBuildSessionStatus(id);
    return c.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Build session not found";
    // Genuine "not found" → 404. Anything else is an internal failure and
    // should surface as 500 so it doesn't get swallowed as a UI "not found".
    const status = err instanceof AppError && err.statusCode === 404 ? 404 : 500;
    if (status === 500) {
      console.error(`[BUILD_STATUS] ${id}:`, err);
    }
    return c.json({ success: false, error: message }, status);
  }
}

/**
 * POST /deployments/:id/redeploy - redeploy from an existing deployment.
 *
 * Body (optional):
 *   { useExistingCommit?: boolean } — when true, rebuilds against the SAME
 *   commit SHA the old deployment used (fallback for users whose artifact
 *   has been purged from the rollback window). Default (omitted/false)
 *   resolves the latest commit on the branch — the auto-redeploy semantic.
 */
export async function buildRedeploy(c: Context) {
  const ctx = getRequestContext(c);
  const id = param(c, "id");
  await permission.assert(getRequestContext(c), { resourceType: "deployment", resourceId: id, action: "write" });

  const body = await c.req
    .json<{ useExistingCommit?: boolean }>()
    .catch(() => ({} as { useExistingCommit?: boolean }));

  try {
    const result = await buildService.redeployBuildSession(ctx, id, {
      useExistingCommit: body.useExistingCommit === true,
    });
    return c.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to redeploy";
    return c.json({ success: false, error: message }, 400);
  }
}

/**
 * POST /deployments/:id/build - start a build for a queued deployment.
 * Kicks off the build pipeline, then streams build logs via SSE.
 * Client can reconnect via GET /:id/stream.
 */
export async function buildStart(c: Context) {
  const ctx = getRequestContext(c);
  const deploymentId = param(c, "id");
  await permission.assert(getRequestContext(c), { resourceType: "deployment", resourceId: deploymentId, action: "write" });

  let result;
  try {
    result = await buildService.startBuild(deploymentId);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to start build";
    return c.json({ success: false, error: message }, 400);
  }

  return streamBuildSession(c, deploymentId, {
    event: "started",
    data: JSON.stringify({
      type: "started",
      deployment_id: result.deployment_id,
      project_id: result.project_id,
    }),
  });
}

export async function sslStatus(c: Context) {
  const ctx = getRequestContext(c);
  const body = await c.req.json<{ domain: string }>();

  if (!body.domain) {
    return c.json({ success: false, error: "domain is required" }, 400);
  }

  try {
    const result = await sslService.getStatus(body.domain, ctx.organizationId);
    return c.json({ success: true, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to check SSL status";
    return c.json({ success: false, error: message }, 400);
  }
}

export async function sslRenew(c: Context) {
  const ctx = getRequestContext(c);
  const body = await c.req.json<{ domain: string; includeWww?: boolean }>();

  if (!body.domain) {
    return c.json({ success: false, error: "domain is required" }, 400);
  }

  try {
    const result = await sslService.renew(body.domain, ctx.organizationId, body.includeWww);
    return c.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to renew SSL";
    return c.json({ success: false, error: message }, 400);
  }
}
