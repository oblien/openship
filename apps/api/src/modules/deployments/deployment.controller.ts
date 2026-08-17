/**
 * Deployment controller - Hono request handlers.
 */

import type { Context } from "hono";
import { AppError, NotFoundError } from "@repo/core";
import { repos } from "@repo/db";
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
import { maskEnv, maskScanService } from "../../lib/secret-env";
import { maybeProxyCloudProject, proxyToSaaS } from "../../lib/cloud/project-router";
import { promoteProjectToCloud, TransferConflictError } from "../projects/transfer.service";
import { env } from "../../config";
import { isMountedRelease, restoreMountedRelease, triggerMountedRelease, triggerUploadedArtifact } from "./mounted-release.service";
import { mountedReleaseBuildMode, mountedReleaseConfig } from "./mounted-release.config";
import { planRelease as classifyRelease } from "./release-planner";
import { assertArtifactSha256, isSha256Hex, normalizeSha256 } from "./release-driver";
import { sha256File } from "@repo/adapters";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
    data: deploymentService.presentDeployments(result.rows),
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
  // Construct the trigger arg from an explicit ALLOWLIST — never forward the
  // raw body. triggerDeployment has internal-only fields (reuseSnapshot,
  // rollbackStrategy, commitShaBefore) that must NOT be settable over HTTP:
  // reuseSnapshot ships a frozen, un-normalized build snapshot verbatim
  // (commands/target/runtimeMode), so leaking it would let a caller inject
  // arbitrary build config. Those fields are only ever set by the internal
  // rollback/webhook callers.
  const result = await buildService.triggerPlannedDeployment(ctx, {
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
  if (result.skipped && !result.deployment) {
    return c.json({ data: { skipped: true, reason: result.reason, plan: result.plan } }, 200);
  }
  return c.json(
    {
      data: {
        ...result,
        deployment: deploymentService.presentDeployment(result.deployment),
        plan: result.plan,
      },
    },
    202,
  );
}

export async function mountedRelease(c: Context) {
  const ctx = getRequestContext(c);
  const body = await c.req.json<{ projectId: string; commitSha?: string }>();
  await permission.assert(ctx, { resourceType: "project", resourceId: body.projectId, action: "write" });
  const dep = await triggerMountedRelease(ctx, body.projectId, { commitSha: body.commitSha });
  return c.json({ data: { deployment_id: dep.id, deployment: deploymentService.presentDeployment(dep) } }, 202);
}

const ARTIFACT_MAX_BYTES = 512 * 1024 * 1024;

export async function uploadArtifact(c: Context) {
  const ctx = getRequestContext(c);
  const form = await c.req.parseBody({ all: true });
  const projectId = String(form.projectId ?? "");
  const claimed = String(form.sha256 ?? "");
  const commitSha = form.commitSha ? String(form.commitSha) : undefined;
  const file = form.file ?? form.artifact;
  if (!projectId) throw new AppError("projectId is required.", 400);
  if (!isSha256Hex(claimed)) throw new AppError("sha256 must be a 64-character hex digest.", 400);
  if (!file || typeof file === "string") throw new AppError("An artifact file is required.", 400);
  await permission.assert(ctx, { resourceType: "project", resourceId: projectId, action: "write" });

  const blob = file as File;
  const size = typeof blob.size === "number" ? blob.size : 0;
  if (size > ARTIFACT_MAX_BYTES) {
    throw new AppError("Artifact exceeds the 512 MB upload limit.", 413, "ARTIFACT_TOO_LARGE");
  }

  const tmp = await mkdtemp(join(tmpdir(), "openship-artifact-"));
  const localPath = join(tmp, "artifact");
  try {
    const bytes = Buffer.from(await blob.arrayBuffer());
    await writeFile(localPath, bytes);
    const actual = await sha256File(localPath);
    assertArtifactSha256(actual, claimed);
    const dep = await triggerUploadedArtifact(ctx, projectId, {
      localPath,
      sha256: normalizeSha256(claimed),
      commitSha,
    });
    return c.json(
      { data: { deployment_id: dep.id, deployment: deploymentService.presentDeployment(dep), sha256: actual } },
      202,
    );
  } catch (error) {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

async function loadPlannerProject(projectId: string, organizationId: string) {
  const project = await repos.project.findById(projectId);
  if (!project || project.organizationId !== organizationId) {
    throw new NotFoundError("Project", projectId);
  }
  const services = await repos.service.listByProject(project.id).catch(() => []);
  return { project, services };
}

export async function planRelease(c: Context) {
  const ctx = getRequestContext(c);
  const body = await c.req.json<{
    projectId: string;
    changedPaths?: string[] | null;
    forceAll?: boolean;
    refresh?: boolean;
    serviceIds?: string[];
  }>();
  await permission.assert(ctx, { resourceType: "project", resourceId: body.projectId, action: "read" });
  const { project, services } = await loadPlannerProject(body.projectId, ctx.organizationId);
  const plan = classifyRelease({
    changedPaths: body.changedPaths === undefined ? null : body.changedPaths,
    mountedReleaseEnabled: Boolean(mountedReleaseConfig(project)),
    buildMode: mountedReleaseConfig(project)
      ? mountedReleaseBuildMode(mountedReleaseConfig(project)!)
      : undefined,
    services: services.map((s) => ({ id: s.id, name: s.name, rootDirectory: s.rootDirectory })),
    preset: project.mountedRelease?.preset,
    routedServiceIds: body.serviceIds,
    forceAll: body.forceAll,
    refreshRequested: body.refresh,
  });
  return c.json({ data: plan });
}

export async function deployCode(c: Context) {
  const ctx = getRequestContext(c);
  const body = await c.req.json<{
    projectId: string;
    branch?: string;
    commitSha?: string;
    serviceIds?: string[];
  }>();
  await permission.assert(ctx, { resourceType: "project", resourceId: body.projectId, action: "write" });
  const result = await buildService.triggerPlannedDeployment(ctx, {
    projectId: body.projectId,
    branch: body.branch,
    commitSha: body.commitSha,
    serviceIds: body.serviceIds,
  });
  if (result.skipped && !result.deployment) {
    return c.json({ skipped: true, reason: result.reason, plan: result.plan });
  }
  return c.json({ operationId: result.deployment.id, plan: result.plan }, 202);
}

export async function rebuildRuntime(c: Context) {
  const ctx = getRequestContext(c);
  const body = await c.req.json<{
    projectId: string;
    branch?: string;
    commitSha?: string;
    serviceIds?: string[];
  }>();
  await permission.assert(ctx, { resourceType: "project", resourceId: body.projectId, action: "write" });
  const result = await buildService.triggerPlannedDeployment(ctx, {
    projectId: body.projectId,
    branch: body.branch,
    commitSha: body.commitSha,
    serviceIds: body.serviceIds,
    forceAll: true,
  });
  if (result.skipped && !result.deployment) {
    return c.json({ skipped: true, reason: result.reason, plan: result.plan });
  }
  return c.json({ operationId: result.deployment.id, plan: result.plan }, 202);
}

export async function rollbackLatest(c: Context) {
  const ctx = getRequestContext(c);
  const body = await c.req.json<{ projectId: string; deploymentId?: string }>();
  await permission.assert(ctx, { resourceType: "project", resourceId: body.projectId, action: "write" });
  const targetId = body.deploymentId ?? (await resolvePreviousDeploymentId(body.projectId, ctx.organizationId));
  if (!targetId) {
    return c.json({ error: "No previous deployment to roll back to" }, 400);
  }
  const preview = await deploymentService.previewRestore(targetId, ctx.organizationId);
  if (preview.needsRepository) {
    await deploymentService.assertGitHubAccessForDeployment(ctx, targetId, ctx.organizationId);
  }
  const target = await deploymentService.getDeployment(targetId, ctx.organizationId);
  if (target.projectId !== body.projectId) {
    return c.json({ error: "Deployment does not belong to this project" }, 400);
  }
  const dep = isMountedRelease(target)
    ? await restoreMountedRelease(ctx, target)
    : await deploymentService.rollbackDeployment(targetId, ctx.organizationId);
  return c.json({ operationId: dep.id }, 202);
}

async function resolvePreviousDeploymentId(projectId: string, organizationId: string): Promise<string | null> {
  const project = await repos.project.findById(projectId);
  if (!project || project.organizationId !== organizationId) return null;
  const listed = await repos.deployment.listByProject(projectId, { page: 1, perPage: 20 });
  const active = new Set(
    [project.activeDeploymentId, project.activeReleaseDeploymentId].filter((id): id is string => Boolean(id)),
  );
  const previous = listed.rows.find((d) => !active.has(d.id) && d.status !== "cancelled" && d.status !== "failed");
  return previous?.id ?? listed.rows.find((d) => !active.has(d.id))?.id ?? null;
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
  return c.json({ data: deploymentService.presentDeployment(dep) });
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
  // GitHub access gate — only when this restore actually needs the repo. A
  // rebuild re-clones, so a member must be granted access (default-deny); an
  // instant restore from a retained image touches no repository at all, and
  // demanding GitHub access for it would block the fastest recovery path for
  // exactly the members most likely to need it.
  const preview = await deploymentService.previewRestore(id, ctx.organizationId);
  if (preview.needsRepository) {
    await deploymentService.assertGitHubAccessForDeployment(ctx, id, ctx.organizationId);
  }
  const target = await deploymentService.getDeployment(id, ctx.organizationId);
  const dep = isMountedRelease(target)
    ? await restoreMountedRelease(ctx, target)
    : await deploymentService.rollbackDeployment(id, ctx.organizationId);
  return c.json({ data: deploymentService.presentDeployment(dep) });
}

/** GET /deployments/:id/restore-plan — how a rollback here would run. */
export async function restorePlan(c: Context) {
  const ctx = getRequestContext(c);
  const id = param(c, "id");
  await permission.assert(ctx, { resourceType: "deployment", resourceId: id, action: "read" });
  return c.json({ data: await deploymentService.previewRestore(id, ctx.organizationId) });
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
  return c.json({ data: deploymentService.presentDeployment(dep) });
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
    return c.json({ ...result, deployment: deploymentService.presentDeployment(result.deployment) });
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
  return c.json({ data: deploymentService.presentDeployment(dep) });
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

/**
 * GET /deployments/:id/pending — what this specific deploy is waiting on.
 *
 * Same builders as the project-scoped view (see pending-actions.service), so the
 * two can't describe one condition differently. This is the one to poll while
 * watching a deploy: a held prompt appears here with its deadline and the exact
 * body that answers it.
 */
export async function pendingActions(c: Context) {
  const ctx = getRequestContext(c);
  const id = param(c, "id");
  await permission.assert(getRequestContext(c), { resourceType: "deployment", resourceId: id, action: "read" });
  const { getDeploymentPendingActions } = await import("../projects/pending-actions.service");
  const actions = await getDeploymentPendingActions(id, ctx.organizationId);
  return c.json({ data: { actions } });
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
    composePath?: string;
    env?: Record<string, string>;
  }>();

  // Determine source - callers may send { owner, repo } without an explicit source
  const source = body.source ?? (body.owner && body.repo ? "github" : undefined);
  const composePath = body.composePath?.trim() || undefined;
  // Interpolation-only: never persisted here, and the response masks every
  // service env below, so supplying a value cannot echo it back unmasked.
  const composeEnv = body.env && Object.keys(body.env).length > 0 ? body.env : undefined;

  try {
    let input: prepareService.Source;

    if (source === "github") {
      if (!body.owner || !body.repo) {
        return c.json({ error: "owner and repo are required" }, 400);
      }
      input = {
        source: "github",
        owner: body.owner,
        repo: body.repo,
        branch: body.branch,
        ctx,
        composePath,
        env: composeEnv,
      };
    } else if (source === "local") {
      if (env.CLOUD_MODE) {
        return c.json({ error: "Local projects are not available in cloud mode" }, 403);
      }
      if (!body.path) {
        return c.json({ error: "path is required" }, 400);
      }
      input = { source: "local", path: body.path, composePath, env: composeEnv };
    } else {
      return c.json({ error: "source must be 'github' or 'local'" }, 400);
    }

    const info = await prepareService.resolveProjectInfo(input);
    // #336: mask env on output like the sibling scan endpoints (scanLocal /
    // folder scan go through projectInfoToScanResponse). The deploy pipeline
    // re-derives real values from source, so masking the scan is display-only.
    return c.json({
      ...info,
      ...(info.services && { services: info.services.map(maskScanService) }),
      ...(info.rootEnv && { rootEnv: maskEnv(info.rootEnv) }),
    });
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
