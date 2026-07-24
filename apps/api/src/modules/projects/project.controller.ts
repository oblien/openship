/**
 * Project controller - Hono request handlers.
 *
 * Every handler:
 *   1. Extracts user from context (set by authMiddleware)
 *   2. Delegates to project.service
 *   3. Returns consistent JSON
 */

import type { Context } from "hono";
import { streamSSE } from "../../lib/sse";
import { assertResourceInOrg, param } from "../../lib/controller-helpers";
import { serviceKind } from "../../lib/deployable-service";
import { reconcileProjectRoutes } from "../../lib/route-apply.service";
import { isLoopbackHost, isReservedLoopbackPort } from "../../lib/public-endpoints";
import { buildUpstreamUrl, resolveRouteStrategy } from "../../lib/upstream-url";
import { getRequestContext } from "../../lib/request-context";
import type { RequestContext } from "../../lib/request-context";
import { permission } from "../../lib/permission";
import { audit, auditContextFrom } from "../../lib/audit";
import * as projectService from "./project.service";
import * as projectTeardown from "./project-teardown";
import { getRouteStrategy } from "../settings/settings.service";
import { checkProjectPorts } from "./port-check.service";
import { checkProjectOutput } from "./output-check.service";
import { AppError, safeErrorMessage } from "@repo/core";
import type {
  TCreateProjectBody,
  TCreateProjectEnvironmentBody,
  TUpdateProjectBody,
  TMergeEnvVarsBody,
  TUpdateResourcesBody,
} from "./project.schema";
import { stat } from "node:fs/promises";
import { repos, type Domain, type Project } from "@repo/db";
import { encrypt } from "../../lib/encryption";
import { deployLuaScripts } from "@repo/adapters";
import { getOpenRestyPaths } from "@/lib/openresty-paths";
import * as domainService from "../domains/domain.service";
import * as prepareService from "../deployments/prepare.service";
import { sshManager } from "../../lib/ssh-manager";
import { env } from "../../config";
import { domainWebhookUrl } from "../../lib/public-url";
import { resolveProjectTrafficSource, fetchMgmt, mgmtStream } from "../../lib/project-analytics";
import { refreshProjectFaviconIfStale } from "../../lib/favicon-detector";
import { getAdminOblienClient } from "../../lib/oblien-user-client";
import { cloudClient } from "../../lib/cloud/client";
import { fetchOrgCloudProjects } from "../../lib/cloud/projects";
import {
  updateWebhook,
  deleteWebhook,
  getWebhookStrategy,
  resolveWebhookStrategy,
  getAvailableStrategies,
  getRecentCommits,
  resolveDefaultBranch,
  listBranches as listGitHubBranches,
} from "../github/github.service";
import { getInstallationIdByOrg, getInstallUrl } from "../github/github.auth";
import { ensureSharedWebhook, findSharedWebhookId } from "./project-git-webhook";
import { listProjectRouteRows, resolveProjectRouteState } from "../domains/project-route.service";

// Track which servers have had Lua scripts deployed this session
const luaDeployedServers = new Set<string>();

function logEnsureProjectError(
  userId: string,
  body: TCreateProjectBody & { projectId?: string },
  err: unknown,
) {
  console.error("[PROJECT] Failed to ensure project", {
    userId,
    projectId: body.projectId,
    name: body.name,
    slug: body.slug,
    gitBranch: body.gitBranch,
    port: body.port,
    publicEndpoints: body.publicEndpoints?.map((endpoint) => ({
      port: endpoint.port,
      targetPath: endpoint.targetPath,
      domain: endpoint.domain,
      customDomain: endpoint.customDomain,
      domainType: endpoint.domainType,
    })),
  });
  console.error(err);

  if (err instanceof Error && err.cause) {
    console.error("[PROJECT] Ensure project cause:", err.cause);
  }
}

// ─── Ensure project ──────────────────────────────────────────────────────────

export async function ensure(c: Context) {
  const ctx = getRequestContext(c);
  const body = await c.req.json<TCreateProjectBody & { projectId?: string }>();

  if (!body.name) {
    return c.json({ success: false, error: "name is required" }, 400);
  }

  try {
    const result = await projectService.ensureProject(body, ctx.organizationId);
    audit.recordAsync(auditContextFrom(c, ctx.organizationId, ctx.userId), {
      eventType: result.created ? "project.created" : "project.updated",
      resourceType: "project",
      resourceId: result.project_id,
      after: {
        name: body.name,
        slug: body.slug ?? null,
        gitBranch: body.gitBranch ?? null,
        port: body.port ?? null,
      },
    });
    return c.json(result);
  } catch (err) {
    logEnsureProjectError(ctx.userId, body, err);

    if (err instanceof AppError) {
      return c.json(
        { success: false, error: err.message, code: err.code },
        err.statusCode as 400 | 401 | 403 | 404 | 409 | 500,
      );
    }

    return c.json({ success: false, error: "Failed to ensure project" }, 500);
  }
}

// ─── Projects CRUD ───────────────────────────────────────────────────────────


/**
 * Project ids a scoped token is allowed to SEE, or null when the caller is not
 * a scoped token (no filtering — normal role visibility applies). For an "own
 * projects" token this is exactly the set it created (auto-granted on create).
 * Security-critical: every project-list surface must filter through this so a
 * scoped token never sees a project it wasn't granted.
 */
async function scopedProjectIds(ctx: RequestContext): Promise<Set<string> | null> {
  if (!ctx.tokenScope) return null;
  const grants = await repos.patGrant.listByToken(ctx.tokenScope.tokenId);
  return new Set(
    grants
      .filter((g) => g.resourceType === "project" && g.resourceId !== "*")
      .map((g) => g.resourceId),
  );
}

export async function getHome(c: Context) {
  const ctx = getRequestContext(c);
  const { userId, organizationId } = ctx;
  const scopedIds = await scopedProjectIds(ctx);

  // Surface a structured payload that includes the user's full org list +
  // a per-org project count. The dashboard uses this to render a
  // "projects in your other orgs" hint when the active org has zero
  // visible projects (prevents the common confusion of "I deployed
  // something but it doesn't show up" when the session active org is
  // a freshly-created empty team org).
  let result: { rows: Awaited<ReturnType<typeof projectService.listProjects>>["rows"]; total: number };
  try {
    result = await projectService.listProjects(organizationId, {
      page: 1,
      // Scoped tokens own few projects but they may sit anywhere in the org's
      // set, so widen the fetch before filtering to the owned ids below.
      perPage: scopedIds ? 1000 : 100,
      });
  } catch (err) {
    // Migrations not yet applied — PGlite first-boot case. Return an
    // explicit empty payload with no other-org hints (we can't query
    // memberships either). Do NOT silently swallow other errors —
    // they'd mask real org-context failures and show the user an
    // empty list with no idea why.
    const msg = safeErrorMessage(err);
    const isMissingTable = /relation .* does not exist|no such table/i.test(msg);
    if (!isMissingTable) {
      console.error("[projects.getHome] listProjects failed:", err);
      return c.json(
        {
          success: false,
          error: "Failed to load projects",
          code: "LIST_FAILED",
          message: msg,
        },
        500,
      );
    }
    return c.json({
      success: true,
      projects: [],
      numbers: { total_projects: 0, total_active_projects: 0, total_deployments: 0, total_success_deployments: 0 },
      otherOrgs: [],
    });
  }

  // Scoped-token isolation: keep only the projects this token may see. Applied
  // BEFORE enrichment + cloud merge so no non-owned project leaks anywhere below.
  if (scopedIds) {
    result.rows = result.rows.filter((p) => scopedIds.has(p.id));
    result.total = result.rows.length;
  }

  // Enrich every project in ONE round trip — batched queries
  // instead of (4 × N) per-project. With 50 projects the old loop
  // fired 200+ SQL statements; this version fires a constant ≤6
  // regardless of project count. The dashboard derives "needs cloud
  // reconnect" client-side from `deployTarget === 'cloud'` +
  // CloudContext.connected — no duplicate server-side flag.
  const projectIds = result.rows.map((p) => p.id);
  const [enrichedProjectsResolved, latestByProject, primariesByProject, servicesByProject, deployStats] =
    await Promise.all([
      projectService.enrichProjectsBatch(result.rows),
      repos.deployment.findLatestByProjects(projectIds),
      repos.domain.getPrimariesByProjects(projectIds),
      repos.service.listByProjects(projectIds),
      // Real Activity-card counts (was hardcoded 0). Scoped to the visible
      // project ids, so scoped tokens only see their own deployments.
      repos.deployment.statsByProjects(projectIds),
    ]);

  const projects = enrichedProjectsResolved.map((enriched, idx) => {
    const original = result.rows[idx];
    const latest = latestByProject.get(original.id);
    const primary = primariesByProject.get(original.id);
    const services = servicesByProject.get(original.id) ?? [];

    refreshProjectFaviconIfStale(original, {
      hostname: primary?.verified ? primary.hostname : null,
    });

    return {
      ...enriched,
      latestDeploymentId: latest?.id ?? null,
      latestDeploymentStatus: latest?.status ?? null,
      primaryDomain: primary?.hostname ?? null,
      serviceCount: services.length,
      hasMultipleServices: services.length > 1,
    };
  });

  // Compute "projects in other orgs" — used by the dashboard when this
  // org has 0 projects to nudge "your projects are over there". Cheap
  // query: one count per other org. Only runs when current org list is
  // empty so the normal case has no extra cost.
  let otherOrgs: Array<{ organizationId: string; name: string; projectCount: number }> = [];
  // Never surface cross-org hints to a scoped token — it must see nothing
  // outside the projects it owns, including counts in the user's other orgs.
  if (!scopedIds && result.total === 0) {
    try {
      const memberships = await repos.member.listByUser(userId);
      const otherOrgIds = memberships
        .map((m) => m.organizationId)
        .filter((id) => id !== organizationId);
      // Batch lookup names + project counts. Names come from one
      // findManyById; counts still go through projectService per org
      // (each is a SELECT COUNT — fine at N < 20 memberships).
      const orgs = await repos.organization
        .findManyById(otherOrgIds)
        .catch(() => []);
      const orgsById = new Map(orgs.map((o) => [o.id, o]));
      otherOrgs = await Promise.all(
        otherOrgIds.map(async (otherOrgId) => {
          const countResult = await projectService
            .listProjects(otherOrgId, { page: 1, perPage: 1 })
            .catch(() => ({ total: 0 }));
          const org = orgsById.get(otherOrgId);
          return {
            organizationId: otherOrgId,
            name: org?.name ?? otherOrgId,
            projectCount: countResult.total,
          };
        }),
      );
      otherOrgs = otherOrgs.filter((o) => o.projectCount > 0);
    } catch (err) {
      console.warn("[projects.getHome] cross-org hint lookup failed:", err);
      otherOrgs = [];
    }
  }

  // Cloud-as-source merge: local projects (this DB) + cloud projects (proxied
  // from the SaaS as the org owner), tagged with `source` so the dashboard can
  // badge them and replay the source hint on subsequent calls.
  const localProjects = projects.map((p) => ({ ...p, source: "local" as const }));

  let mergedProjects: unknown[] = localProjects;
  let cloudProjectCount = 0;
  let cloudDeployments = 0;
  let cloudSuccessDeployments = 0;
  let cloudPartial = false;
  // Skip the cloud merge for a scoped token — cloud projects are ones it didn't
  // create, so they must stay invisible. Only the owner's full session/token
  // sees the local+cloud union.
  if (!scopedIds) {
    const cloud = await fetchOrgCloudProjects(organizationId);
    if (cloud.state === "merged") {
      const localIds = new Set(localProjects.map((p) => (p as { id: string }).id));
      const cloudProjects = cloud.projects
        .filter((p) => !localIds.has((p.id as string) ?? ""))
        .map((p) => ({ ...p, source: "cloud" as const }));
      mergedProjects = [...localProjects, ...cloudProjects];
      cloudProjectCount =
        Number(cloud.numbers.total_projects ?? cloudProjects.length) || cloudProjects.length;
      const cloudNums = cloud.numbers as Record<string, unknown>;
      cloudDeployments = Number(cloudNums.total_deployments ?? 0) || 0;
      cloudSuccessDeployments = Number(cloudNums.total_success_deployments ?? 0) || 0;
    } else if (cloud.state === "unavailable") {
      cloudPartial = true;
    }
  }

  // The "projects in other orgs" nudge is only useful when the view is truly
  // empty — suppress it once we have any project to show (local or cloud).
  if (mergedProjects.length > 0) otherOrgs = [];

  return c.json({
    success: true,
    projects: mergedProjects,
    numbers: {
      total_projects: result.total + cloudProjectCount,
      // Alias the dashboard reads (Activity card + ActivityChart "live projects").
      total_active_projects: result.total + cloudProjectCount,
      total_deployments: deployStats.total + cloudDeployments,
      total_success_deployments: deployStats.success + cloudSuccessDeployments,
    },
    otherOrgs,
    ...(cloudPartial ? { cloudPartial: true } : {}),
  });
}

export async function list(c: Context) {
  const ctx = getRequestContext(c);
  const { organizationId } = ctx;
  const scopedIds = await scopedProjectIds(ctx);
  const page = Number(c.req.query("page") ?? 1);
  const perPage = Number(c.req.query("perPage") ?? 20);
  const result = await projectService.listProjects(
    organizationId,
    scopedIds ? { page: 1, perPage: 1000 } : { page, perPage },
  );
  // Scoped-token isolation: keep only the projects this token may see.
  const rows = scopedIds ? result.rows.filter((p) => scopedIds.has(p.id)) : result.rows;
  rows.forEach((project) => {
    refreshProjectFaviconIfStale(project);
  });
  // Tag source for consistency with the home merge. Cloud-project merge for
  // this paginated endpoint is deferred (the dashboard list uses getHome); the
  // tag keeps the field shape uniform for clients that read /projects.
  return c.json({
    data: rows.map((p) => ({ ...p, source: "local" as const })),
    total: scopedIds ? rows.length : result.total,
    page: scopedIds ? 1 : result.page,
    perPage: scopedIds ? rows.length : result.perPage,
  });
}

export async function create(c: Context) {
  const ctx = getRequestContext(c);
  const { userId, organizationId } = ctx;
  const body = await c.req.json<TCreateProjectBody>();
  // Seed the edge→app route strategy from the creator's default when the
  // request didn't specify one. Only a non-"auto" default is written (auto is
  // the schema default → loopback-port), so this is a no-op for most users.
  if (body.routeStrategy === undefined) {
    const routeDefault = await getRouteStrategy(userId).catch(() => "auto" as const);
    if (routeDefault !== "auto") body.routeStrategy = routeDefault;
  }
  const project = await projectService.createProject(body, organizationId);
  audit.recordAsync(auditContextFrom(c, organizationId, userId), {
    eventType: "project.created",
    resourceType: "project",
    resourceId: project.id,
    after: {
      name: project.name,
      slug: project.slug,
      framework: project.framework ?? null,
      gitProvider: project.gitProvider ?? null,
      gitOwner: project.gitOwner ?? null,
      gitRepo: project.gitRepo ?? null,
      gitBranch: project.gitBranch ?? null,
    },
  });
  // A scoped token that just created a project now fully controls it: record a
  // per-project grant so later reads/writes/deletes on this id pass the
  // restricted-principal check. Only a token carrying a project `create` grant
  // can reach this route (see permission.ts), so this is exactly the "projects
  // it creates" scope accruing ownership. No-op for sessions or full tokens.
  if (ctx.tokenScope) {
    await repos.patGrant.createMany(ctx.tokenScope.tokenId, [
      { resourceType: "project", resourceId: project.id, permissions: ["read", "write", "admin"] },
    ]);
  }
  return c.json({ data: project }, 201);
}

export async function getById(c: Context) {
  const ctx = getRequestContext(c);
  const { userId, organizationId } = ctx;
  const id = param(c, "id");
  await permission.assert(getRequestContext(c), { resourceType: "project", resourceId: id, action: "read" });
  const project = await projectService.getProject(id, organizationId);
  refreshProjectFaviconIfStale(project);
  return c.json({ data: project });
}

// ─── Project environments ───────────────────────────────────────────────────

export async function listEnvironments(c: Context) {
  const ctx = getRequestContext(c);
  const { userId, organizationId } = ctx;
  const id = param(c, "id");
  await permission.assert(getRequestContext(c), { resourceType: "project", resourceId: id, action: "read" });
  const data = await projectService.listProjectEnvironments(id, organizationId);
  return c.json({ success: true, data });
}

export async function createEnvironment(c: Context) {
  const ctx = getRequestContext(c);
  const { userId, organizationId } = ctx;
  const id = param(c, "id");
  await permission.assert(getRequestContext(c), { resourceType: "project", resourceId: id, action: "write" });
  const body = await c.req.json<TCreateProjectEnvironmentBody>();

  if (!body.environmentName?.trim()) {
    return c.json({ success: false, error: "environmentName is required" }, 400);
  }

  try {
    const data = await projectService.createProjectEnvironment(id, ctx, body);
    audit.recordAsync(auditContextFrom(c, organizationId, userId), {
      eventType: "project.updated",
      resourceType: "project",
      resourceId: id,
      after: {
        action: "environment.created",
        environmentId: data.id,
        environmentName: data.name,
        environmentSlug: data.slug,
        environmentType: data.type,
        gitBranch: data.gitBranch,
      },
    });
    return c.json({ success: true, data }, 201);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to create environment";
    return c.json({ success: false, error: message }, 400);
  }
}

export async function update(c: Context) {
  const ctx = getRequestContext(c);
  const { userId, organizationId } = ctx;
  const id = param(c, "id");
  await permission.assert(getRequestContext(c), { resourceType: "project", resourceId: id, action: "write" });
  const body = await c.req.json<TUpdateProjectBody>();
  const project = await projectService.updateProject(id, body, organizationId);
  audit.recordAsync(auditContextFrom(c, organizationId, userId), {
    eventType: "project.updated",
    resourceType: "project",
    resourceId: project.id,
    after: {
      name: project.name,
      slug: project.slug,
      gitOwner: project.gitOwner ?? null,
      gitRepo: project.gitRepo ?? null,
      gitBranch: project.gitBranch ?? null,
    },
  });
  return c.json({ data: project });
}

/**
 * Atomic project delete.
 *
 * Two paths:
 *   - graceful (default):  refuse with 409 if any deployment / build /
 *                          backup is still in flight. The dashboard
 *                          surfaces `active` so the user can cancel
 *                          and retry.
 *   - force=true (query):  cancel active work, wait up to 5s for
 *                          confirmed quiescence, then teardown.
 *
 * Both paths converge into `teardownProject`, which runs a named,
 * audited step sequence and reports per-step success/failure. The DB
 * row only drops after remote cleanup; FK CASCADE handles dependents.
 */
export async function remove(c: Context) {
  const ctx = getRequestContext(c);
  const { userId, organizationId } = ctx;
  const id = param(c, "id");
  await permission.assert(getRequestContext(c), { resourceType: "project", resourceId: id, action: "admin" });

  const force = c.req.query("force") === "true";
  // Orphan-and-drop even when a resource on a REACHABLE server won't destroy
  // (a persistent real error). Unreachable-server resources are ALWAYS orphaned
  // regardless — that's the enforced delete.
  const forceOrphan = c.req.query("forceOrphan") === "true";
  // Body is still accepted for wipeVolumes (dashboard sends JSON), but
  // optional — query overrides body when both are present.
  let bodyWipeVolumes: boolean | undefined;
  try {
    const body = await c.req.json<{ wipeVolumes?: boolean }>();
    bodyWipeVolumes = body?.wipeVolumes;
  } catch {
    /* no body — fine */
  }
  const wipeVolumes = c.req.query("wipeVolumes") === "true" || bodyWipeVolumes === true;
  // Record-only ("soft") delete: drop the Openship record, keep the server
  // workload + data. Self-hosted only — teardownProject ignores it for a cloud
  // project (the security boundary; this query flag is just the request).
  const recordOnly = c.req.query("recordOnly") === "true";

  // Verify project exists in this org BEFORE the gate so we don't
  // leak "active work" details for a project that isn't ours.
  const proj = await repos.project.findById(id);
  if (!proj || proj.organizationId !== organizationId) {
    // No audit on 404 — a stale URL isn't a deletion attempt worth
    // surfacing in the audit feed. Security teams only want failed
    // attempts on resources the actor could actually see.
    return c.json({ ok: false, error: "Project not found" }, 404);
  }
  // The Openship control plane deploys itself; deleting its app row would drop
  // the Apps entry + domain while the host service keeps running (and orphan the
  // edge route). It's managed from the CLI, never torn down via the dashboard.
  if (proj.appTemplateId === "openship") {
    return c.json(
      {
        ok: false,
        code: "PROJECT_IS_CONTROL_PLANE",
        error: "This is the Openship control plane — manage it with the CLI, not the dashboard.",
      },
      403,
    );
  }
  if (proj.deletionInProgress) {
    audit.recordAsync(auditContextFrom(c, organizationId, userId), {
      eventType: "project.deletion.rejected",
      resourceType: "project",
      resourceId: id,
      after: { code: "PROJECT_DELETION_IN_PROGRESS", force, wipeVolumes },
    });
    return c.json(
      {
        ok: false,
        code: "PROJECT_DELETION_IN_PROGRESS",
        error: "Deletion already in progress for this project",
      },
      409,
    );
  }

  // ── Graceful gate. ────────────────────────────────────────────────
  if (!force) {
    const active = await projectTeardown.getActiveProjectState(id);
    if (active.blocking) {
      audit.recordAsync(auditContextFrom(c, organizationId, userId), {
        eventType: "project.deletion.rejected",
        resourceType: "project",
        resourceId: id,
        after: {
          code: "PROJECT_HAS_ACTIVE_WORK",
          force,
          wipeVolumes,
          active: {
            hasActiveDeployment: active.hasActiveDeployment,
            hasActiveBackup: active.hasActiveBackup,
            hasActiveBackupRestore: active.hasActiveBackupRestore,
            deploymentIds: active.activeDeploymentIds,
            backupRunIds: active.activeBackupRunIds,
            backupRestoreIds: active.activeBackupRestoreIds,
          },
        },
      });
      return c.json(
        {
          ok: false,
          code: "PROJECT_HAS_ACTIVE_WORK",
          error: active.summary,
          active: {
            hasActiveDeployment: active.hasActiveDeployment,
            hasActiveBackup: active.hasActiveBackup,
            hasActiveBackupRestore: active.hasActiveBackupRestore,
            deploymentIds: active.activeDeploymentIds,
            backupRunIds: active.activeBackupRunIds,
            backupRestoreIds: active.activeBackupRestoreIds,
          },
        },
        409,
      );
    }
  }

  // ── Run the atomic teardown. ──────────────────────────────────────
  const result = await projectTeardown.teardownProject(ctx, id, {
    force,
    forceOrphan,
    wipeVolumes,
    recordOnly,
  });

  // Typed pre-step rejections short-circuit before we record a
  // `project.deleted` row. Each gets its own audit event + HTTP code.
  if (result.rejection === "claim_lock_held") {
    audit.recordAsync(auditContextFrom(c, organizationId, userId), {
      eventType: "project.deletion.rejected",
      resourceType: "project",
      resourceId: id,
      after: { code: "PROJECT_DELETION_IN_PROGRESS", force, wipeVolumes },
    });
    return c.json(
      {
        ok: false,
        code: "PROJECT_DELETION_IN_PROGRESS",
        error: "Deletion already in progress for this project",
      },
      409,
    );
  }
  if (result.rejection === "already_deleted") {
    // Idempotent: row's already gone, treat as success so the dashboard
    // navigates the user away. No audit row for a "deletion of a thing
    // that wasn't there" — matches the controller's 404 behavior.
    return c.json({ ok: true, message: "already deleted", steps: result.steps });
  }
  if (result.rejection === "org_mismatch") {
    // Belt-and-suspenders against a future caller skipping the
    // controller's org check. We DO emit a rejection event because the
    // actor was authenticated and the org check was bypassed somehow —
    // a real security signal.
    audit.recordAsync(auditContextFrom(c, organizationId, userId), {
      eventType: "project.deletion.rejected",
      resourceType: "project",
      resourceId: id,
      after: { code: "PROJECT_ORG_MISMATCH", force, wipeVolumes },
    });
    return c.json({ ok: false, code: "PROJECT_ORG_MISMATCH", error: "Project not found" }, 404);
  }

  audit.recordAsync(auditContextFrom(c, organizationId, userId), {
    eventType: "project.deleted",
    resourceType: "project",
    resourceId: id,
    after: {
      force,
      wipeVolumes,
      recordOnly,
      ok: result.ok,
      rowDeleted: result.rowDeleted,
      steps: result.steps,
    },
  });

  // The row is gone but a non-empty `unrecoverable` means ops needs to
  // clean up stragglers (a leaked container, a webmail dir we couldn't
  // wipe). 207 surfaces this so the dashboard can warn the user.
  if (result.rowDeleted && result.unrecoverable.length > 0) {
    return c.json(
      {
        ok: false,
        message: "Project deleted, but some external cleanup failed",
        steps: result.steps,
        unrecoverable: result.unrecoverable,
      },
      207,
    );
  }

  // Row still around — teardown couldn't complete. This is now ONLY the
  // "reachable server but destroy kept failing" case (unreachable resources are
  // orphaned and the row drops). 409 so the caller can retry, and
  // `canForceOrphan` tells the dashboard it may offer a force-orphan delete
  // that records the leaked resources for GC and drops the row anyway.
  if (!result.rowDeleted) {
    return c.json(
      {
        ok: false,
        code: "PROJECT_TEARDOWN_FAILED",
        canForceOrphan: true,
        message: result.unrecoverable[0]?.error ?? "Teardown failed",
        steps: result.steps,
        unrecoverable: result.unrecoverable,
      },
      409,
    );
  }

  return c.json({
    ok: true,
    message: "deleted",
    steps: result.steps,
    // Resources that couldn't be reached at delete time — recorded for GC to
    // reclaim once the server is back. Drives the "will be cleaned up when the
    // server is reachable" toast. Empty on a fully-clean delete.
    orphaned: result.orphaned,
  });
}

export async function deletionPreview(c: Context) {
  const ctx = getRequestContext(c);
  const { organizationId } = ctx;
  const id = param(c, "id");
  await permission.assert(getRequestContext(c), { resourceType: "project", resourceId: id, action: "read" });
  const { repos } = await import("@repo/db");
  const project = await repos.project.findById(id);
  try {
    assertResourceInOrg(project, "Project", organizationId, id);
  } catch {
    return c.json({ success: false, error: "project-not-found" }, 404);
  }
  const preview = await projectService.previewProjectDeletion(project);
  return c.json({ success: true, preview });
}

// ─── Environment variables ───────────────────────────────────────────────────

export async function listEnvVars(c: Context) {
  const ctx = getRequestContext(c);
  const { userId, organizationId } = ctx;
  const id = param(c, "id");
  await permission.assert(getRequestContext(c), { resourceType: "project", resourceId: id, action: "read" });
  const environment = c.req.query("environment");
  const vars = await projectService.listEnvVars(id, organizationId, environment);
  return c.json({ data: vars });
}

export async function mergeEnvVars(c: Context) {
  const ctx = getRequestContext(c);
  const { userId, organizationId } = ctx;
  const id = param(c, "id");
  await permission.assert(getRequestContext(c), { resourceType: "project", resourceId: id, action: "write" });
  const body = await c.req.json<TMergeEnvVarsBody>();
  const result = await projectService.mergeEnvVars(id, organizationId, body);
  audit.recordAsync(auditContextFrom(c, organizationId, userId), {
    eventType: "project.updated",
    resourceType: "project",
    resourceId: id,
    after: {
      action: "envVars.merge",
      environment: body.environment,
      // Names only - never echo the secret values.
      upsertedNames: (body.upserts ?? []).map((v) => v.key),
      deletedNames: body.deletes ?? [],
    },
  });
  return c.json(result);
}

// ─── Resources ───────────────────────────────────────────────────────────────

export async function getResources(c: Context) {
  const id = param(c, "id");
  await permission.assert(getRequestContext(c), { resourceType: "project", resourceId: id, action: "read" });
  // org AFTER assert (cross-org rebind safety — see enable/disable).
  const { organizationId } = getRequestContext(c);
  const resources = await projectService.getResources(id, organizationId);
  return c.json({ data: resources });
}

/** POST /projects/:id/port-check — live, on-demand port-reachability audit of
 *  the active deployment's container(s). Advisory (never throws on probe
 *  failure); powers the Domains tab's "port not reachable" hint. */
export async function portCheck(c: Context) {
  const ctx = getRequestContext(c);
  const id = param(c, "id");
  await permission.assert(ctx, { resourceType: "project", resourceId: id, action: "read" });
  const checks = await checkProjectPorts(ctx, id);
  return c.json({ data: checks });
}

/** POST /projects/:id/output-check — live static-output audit of the active
 *  deployment (advisory; static apps only). Powers the Domains tab's "no output
 *  found at this path" hint — the file-side twin of /port-check. */
export async function outputCheck(c: Context) {
  const ctx = getRequestContext(c);
  const id = param(c, "id");
  await permission.assert(ctx, { resourceType: "project", resourceId: id, action: "read" });
  const checks = await checkProjectOutput(ctx, id);
  return c.json({ data: checks });
}

export async function updateResources(c: Context) {
  const id = param(c, "id");
  await permission.assert(getRequestContext(c), { resourceType: "project", resourceId: id, action: "write" });
  // org AFTER assert (cross-org rebind safety — see enable/disable).
  const { userId, organizationId } = getRequestContext(c);
  const body = await c.req.json<TUpdateResourcesBody>();
  const resources = await projectService.updateResources(id, body, organizationId);
  audit.recordAsync(auditContextFrom(c, organizationId, userId), {
    eventType: "project.updated",
    resourceType: "project",
    resourceId: id,
    after: {
      action: "resources.updated",
      production: body.production ?? null,
      build: body.build ?? null,
      sleepMode: body.sleepMode ?? null,
      port: body.port ?? null,
    },
  });
  return c.json({ data: resources });
}

// ─── Clone token (per-project override) ──────────────────────────────────────

/**
 * GET /projects/:id/clone-token - read-only state. Never returns the token,
 * only whether one is set and when it was set last.
 */
export async function getCloneToken(c: Context) {
  const ctx = getRequestContext(c);
  const { userId, organizationId } = ctx;
  const id = param(c, "id");
  await permission.assert(getRequestContext(c), { resourceType: "project", resourceId: id, action: "read" });
  const project = await projectService.getProject(id, organizationId);
  return c.json({
    hasToken: !!project.cloneTokenEncrypted,
    setAt: project.cloneTokenSetAt?.toISOString() ?? null,
  });
}

/**
 * PATCH /projects/:id/clone-token - set/replace/clear the per-project clone token.
 *
 * Body:
 *   { token?: string | null }
 *
 *   token === null → clear.
 *   token: string  → encrypt and store. Empty string treated as clear.
 *
 * The token is encrypted on save and never echoed back. Resolves the chain
 * tier: project token > user-global > App > mode default.
 */
export async function updateCloneToken(c: Context) {
  const ctx = getRequestContext(c);
  const { userId, organizationId } = ctx;
  const id = param(c, "id");
  await permission.assert(getRequestContext(c), { resourceType: "project", resourceId: id, action: "admin" });
  const body = await c.req.json().catch(() => ({}));
  const rawToken = body?.token;

  const project = await projectService.getProject(id, organizationId);

  if (rawToken === null || rawToken === "") {
    await repos.project.update(project.id, {
      cloneTokenEncrypted: null,
      cloneTokenSetAt: null,
    });
    audit.recordAsync(auditContextFrom(c, organizationId, userId), {
      eventType: "project.updated",
      resourceType: "project",
      resourceId: project.id,
      after: { action: "cloneToken.cleared" },
    });
    return c.json({ hasToken: false, setAt: null });
  }

  if (typeof rawToken !== "string" || rawToken.length === 0) {
    return c.json({ error: "token must be a non-empty string or null" }, 400);
  }

  await repos.project.update(project.id, {
    cloneTokenEncrypted: encrypt(rawToken),
    cloneTokenSetAt: new Date(),
  });

  const setAt = new Date().toISOString();
  audit.recordAsync(auditContextFrom(c, organizationId, userId), {
    eventType: "project.updated",
    resourceType: "project",
    resourceId: project.id,
    after: { action: "cloneToken.set", setAt },
  });
  return c.json({ hasToken: true, setAt });
}

// ─── Local projects ──────────────────────────────────────────────────────────

/** Scan a local directory and detect framework/stack */
export async function scanLocal(c: Context) {
  if (env.CLOUD_MODE) return c.notFound();

  const { path: dirPath } = await c.req.json<{ path: string }>();
  if (!dirPath) return c.json({ error: "path is required" }, 400);

  // Validate the path exists and is a directory
  try {
    const st = await stat(dirPath);
    if (!st.isDirectory()) return c.json({ error: "Path is not a directory" }, 400);
  } catch {
    return c.json({ error: "Directory not found" }, 404);
  }

  const result = await prepareService.resolveProjectInfo({ source: "local", path: dirPath });

  return c.json({
    success: true,
    path: dirPath,
    ...prepareService.projectInfoToScanResponse(result),
  });
}

/** Import a local folder as a project */
export async function importLocal(c: Context) {
  if (env.CLOUD_MODE) return c.notFound();

  const ctx = getRequestContext(c);
  const { userId, organizationId } = ctx;
  const body = await c.req.json<TCreateProjectBody & { localPath: string }>();

  if (!body.localPath) return c.json({ error: "localPath is required" }, 400);

  // Verify directory exists
  try {
    const st = await stat(body.localPath);
    if (!st.isDirectory()) return c.json({ error: "Path is not a directory" }, 400);
  } catch {
    return c.json({ error: "Directory not found" }, 404);
  }

  const project = await projectService.createProject(
    {
      ...body,
      gitProvider: "local",
    },
    organizationId,
  );

  return c.json({ data: project }, 201);
}

/** List only local projects for the current user */
export async function listLocal(c: Context) {
  if (env.CLOUD_MODE) return c.notFound();

  const ctx = getRequestContext(c);
  const { organizationId } = ctx;
  try {
    const scopedIds = await scopedProjectIds(ctx);
    const result = await projectService.listProjects(organizationId, {
      page: 1,
      perPage: scopedIds ? 1000 : 100,
      });
    let localProjects = result.rows.filter((p) => p.gitProvider === "local");
    // Scoped-token isolation: only the projects this token may see.
    if (scopedIds) localProjects = localProjects.filter((p) => scopedIds.has(p.id));
    return c.json({ success: true, projects: localProjects });
  } catch {
    return c.json({ success: true, projects: [] });
  }
}

// ─── Runtime logs ────────────────────────────────────────────────────────────

/**
 * GET /projects/:id/logs - one-shot fetch of recent runtime logs.
 */
export async function runtimeLogs(c: Context) {
  const ctx = getRequestContext(c);
  const { userId, organizationId } = ctx;
  const id = param(c, "id");
  await permission.assert(getRequestContext(c), { resourceType: "project", resourceId: id, action: "read" });
  const tail = c.req.query("tail") ? Number(c.req.query("tail")) : undefined;

  try {
    const entries = await projectService.getRuntimeLogs(id, organizationId, tail);
    return c.json({ data: entries });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to get logs";
    return c.json({ error: message }, 400);
  }
}

/**
 * GET /projects/:id/logs/stream - SSE stream of runtime logs.
 */
export async function runtimeLogStream(c: Context) {
  const ctx = getRequestContext(c);
  const { userId, organizationId } = ctx;
  const id = param(c, "id");
  await permission.assert(getRequestContext(c), { resourceType: "project", resourceId: id, action: "read" });
  const tail = c.req.query("tail") ? Number(c.req.query("tail")) : undefined;

  return streamSSE(c, async (sseStream) => {
    let cleanup: (() => void) | null = null;
    let serverId: string | null = null;

    try {
      const result = await projectService.streamRuntimeLogs(
        id,
        organizationId,
        (entry) => {
          void sseStream.writeSSE({
            event: "log",
            data: JSON.stringify({
              type: "log",
              data: entry.rawData,
              message: entry.message,
              timestamp: entry.timestamp,
              level: entry.level,
            }),
          });
        },
        { tail },
      );

      cleanup = result.cleanup;
      serverId = result.serverId;
      if (serverId) sshManager.retain(serverId);

      // Keep the stream open until client disconnects
      await new Promise<void>((resolve) => {
        sseStream.onAbort(() => {
          cleanup?.();
          resolve();
        });
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to stream logs";
      await sseStream.writeSSE({ event: "error", data: JSON.stringify({ error: message }) });
      cleanup?.();
    } finally {
      if (serverId) sshManager.release(serverId);
    }
  });
}

// ─── Server HTTP request logs ────────────────────────────────────────────────

function extractCloudStreamToken(result: unknown): { stream_url: string; token: string } | null {
  // The payload nesting DIFFERS by path:
  //   • admin-direct (Oblien SDK):  { success, data: { stream_url, token, … } }  ← 1 level
  //   • cloud-proxied (SaaS wraps the SDK response again): { data: { success, data: { stream_url, token } } }  ← 2 levels
  // So walk down through nested `data`/`result` wrappers until we hit the object
  // that actually carries stream_url + token, instead of assuming a fixed depth.
  let node: unknown = result;
  for (let depth = 0; depth < 4 && node && typeof node === "object"; depth++) {
    const obj = node as Record<string, unknown>;
    const streamUrl =
      obj.stream_url ?? obj.streamUrl ?? obj.url ?? obj.sse_url ?? obj.endpoint;
    const token =
      obj.token ?? obj.stream_token ?? obj.streamToken ?? obj.access_token ?? obj.jwt;
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

/**
 * GET /projects/:id/server-logs/stream-token
 *
 * Returns { kind: "cloud", url, token } or { kind: "self-hosted" }.
 * For cloud projects the dashboard connects directly to the edge SSE stream.
 */
export async function serverLogStreamToken(c: Context) {
  const ctx = getRequestContext(c);
  const { userId, organizationId } = ctx;
  const id = param(c, "id");
  await permission.assert(getRequestContext(c), { resourceType: "project", resourceId: id, action: "read" });

  const project = await repos.project.findById(id);
  try {
    assertResourceInOrg(project, "Project", organizationId, id);
  } catch {
    return c.json({ error: "Project not found" }, 404);
  }

  const source = await resolveProjectTrafficSource(id, { domain: c.req.query("domain") });
  if (!source) {
    return c.json({ error: "No domain configured for this project" }, 400);
  }

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
      return c.json({ kind: "unavailable" as const });
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
      return c.json({ kind: "unavailable" as const });
    }
    return c.json({ kind: "cloud" as const, url: tokenData.stream_url, token: tokenData.token });
  }

  return c.json({ kind: "self-hosted" as const });
}

/**
 * GET /projects/:id/server-logs/stream - SSE stream of HTTP request logs
 * from the OpenResty pipe_stream on the managed server.
 *
 * Cloud projects use stream-token + direct edge connection instead.
 * Auto-deploys Lua scripts once per API session per server.
 */
export async function serverLogStream(c: Context) {
  const ctx = getRequestContext(c);
  const { organizationId } = ctx;
  const id = param(c, "id");
  await permission.assert(getRequestContext(c), { resourceType: "project", resourceId: id, action: "read" });

  const project = await repos.project.findById(id);
  try {
    assertResourceInOrg(project, "Project", organizationId, id);
  } catch {
    return c.json({ error: "Project not found" }, 404);
  }

  const source = await resolveProjectTrafficSource(id, { domain: c.req.query("domain") });
  if (!source || source.kind !== "self-hosted") {
    return c.json({ error: "Use stream-token endpoint for cloud projects" }, 400);
  }

  const { domain, serverId } = source;

  return streamSSE(c, async (sseStream) => {
    sshManager.retain(serverId);
    try {
      if (!luaDeployedServers.has(serverId)) {
        try {
          const executor = await sshManager.acquire(serverId);
          const paths = await getOpenRestyPaths(serverId, executor);
          await deployLuaScripts(executor, paths);
          luaDeployedServers.add(serverId);
        } catch {
          // Non-fatal - scripts may already be up to date
        }
      }

      const reqPath = `/logs/stream?domain=${encodeURIComponent(domain)}`;
      const conn = await mgmtStream(serverId, reqPath);
      if (!conn) {
        await sseStream
          .writeSSE({
            event: "error",
            data: JSON.stringify({
              error: "Failed to connect to log service - ensure OpenResty is running",
            }),
          })
          .catch(() => {});
        return;
      }

      sseStream.onAbort(() => conn.destroy());

      await new Promise<void>((resolve) => {
        conn.stream.on("data", (chunk: Buffer) => {
          sseStream.write(chunk.toString()).catch(() => conn.destroy());
        });
        conn.stream.on("close", () => resolve());
        conn.stream.on("end", () => resolve());
        conn.stream.on("error", () => resolve());
      });
    } finally {
      sshManager.release(serverId);
    }
  });
}

// ─── Recent server logs ──────────────────────────────────────────────────────

export async function recentServerLogs(c: Context) {
  const ctx = getRequestContext(c);
  const { userId, organizationId } = ctx;
  const id = param(c, "id");
  await permission.assert(getRequestContext(c), { resourceType: "project", resourceId: id, action: "read" });

  const project = await repos.project.findById(id);
  try {
    assertResourceInOrg(project, "Project", organizationId, id);
  } catch {
    return c.json({ error: "Project not found" }, 404);
  }

  const source = await resolveProjectTrafficSource(id, { domain: c.req.query("domain") });
  if (!source) {
    return c.json({ logs: [] });
  }

  const limit = Math.min(Math.max(parseInt(c.req.query("limit") || "50", 10) || 50, 1), 200);

  if (source.kind === "cloud") {
    const client = getAdminOblienClient();
    let result: unknown = null;

    if (client) {
      try {
        result = await client.analytics.requests(source.domain, { limit });
      } catch {
        return c.json({ logs: [] });
      }
    } else {
      result = await cloudClient({ organizationId }).analytics.requests(source.domain, { limit });
    }

    return c.json({ logs: extractCloudRequestLogs(result) });
  }

  const { domain, serverId } = source;

  const entries = await fetchMgmt<unknown[]>(
    serverId,
    `/logs/recent?domain=${encodeURIComponent(domain)}&limit=${limit}`,
  );
  return c.json({ logs: entries ?? [] });
}

// ─── Git info ────────────────────────────────────────────────────────────────

export async function getGitInfo(c: Context) {
  const ctx = getRequestContext(c);
  const userId = ctx.userId;
  const organizationId = ctx.organizationId;
  const id = param(c, "id");
  await permission.assert(getRequestContext(c), { resourceType: "project", resourceId: id, action: "read" });
  const info = await projectService.getGitInfo(id, organizationId);

  // No repo linked yet — the normal state for upload/local projects, not a
  // failure. The `code` lets the client render an inline "connect a repo" empty
  // state instead of a full-page repo-not-found takeover (see GitSettings).
  if (!info.gitOwner || !info.gitRepo) {
    return c.json({ success: false, error: "No repository connected", code: "NO_REPOSITORY" });
  }

  const strategy = await resolveWebhookStrategy(info);

  // Cloud projects (deployTarget=cloud) need the GitHub App installed - regardless
  // of whether this server is the SaaS or a local instance connected to cloud.
  const isCloudProject = info.deployTarget === "cloud";
  let installationInstalled = false;
  if (isCloudProject && info.gitOwner) {
    const instId = await getInstallationIdByOrg(organizationId, info.gitOwner);
    installationInstalled = !!instId;
  }

  let sharedWebhookId = info.webhookId ?? null;
  if (!sharedWebhookId && info.gitOwner && info.gitRepo) {
    sharedWebhookId = await findSharedWebhookId(organizationId, info.gitOwner, info.gitRepo);
  }

  // Derive webhook_active from strategy + state
  const webhookActive =
    strategy === "app"
      ? installationInstalled
      : strategy === "domain"
        ? !!(info.autoDeploy && sharedWebhookId)
        : strategy === "repo"
          ? !!(info.autoDeploy && sharedWebhookId)
          : false;

  // Get available strategies for the UI
  const strategies = await getAvailableStrategies(ctx, info);

  // Get project domains for webhook domain picker
  const domains = await repos.domain.listByProject(id);
  const verifiedDomains = domains
    .filter((d) => d.verified)
    .map((d) => ({ hostname: d.hostname, ssl: d.sslStatus === "active" }));

  let branch = info.gitBranch ?? "";
  if (!branch && info.gitOwner && info.gitRepo) {
    branch = await resolveDefaultBranch(ctx, info.gitOwner, info.gitRepo);
  }
  const commits = branch
    ? await getRecentCommits(ctx, info.gitOwner, info.gitRepo, branch, 10)
    : [];

  return c.json({
    success: true,
    owner: info.gitOwner,
    repo: info.gitRepo,
    branch,
    provider: info.gitProvider ?? "github",
    commits: commits.map((c) => ({
      sha: c.sha,
      message: c.message,
      author: c.author,
      author_avatar: c.authorAvatar,
      date: c.date,
      url: c.url,
    })),
    auto_deploy: info.autoDeploy ?? false,
    webhook_strategy: strategy,
    webhook_active: webhookActive,
    webhook_domain: info.webhookDomain ?? null,
    available_strategies: strategies.available,
    verified_domains: verifiedDomains,
    installation_installed: installationInstalled,
    install_url: isCloudProject && !installationInstalled ? getInstallUrl() : undefined,
    default_rollback_strategy: info.defaultRollbackStrategy ?? "git",
  });
}

export async function listBranches(c: Context) {
  const ctx = getRequestContext(c);
  const { userId, organizationId } = ctx;
  const id = param(c, "id");
  await permission.assert(getRequestContext(c), { resourceType: "project", resourceId: id, action: "read" });
  const info = await projectService.getGitInfo(id, organizationId);

  if (!info.gitOwner || !info.gitRepo) {
    return c.json({ success: false, error: "No repository connected" }, 400);
  }

  const branches = await listGitHubBranches(ctx, info.gitOwner, info.gitRepo);
  return c.json({
    success: true,
    data: branches.map((branch) => ({
      name: branch.name,
      sha: branch.commit.sha,
      protected: branch.protected,
    })),
  });
}

/**
 * POST /projects/:id/git/link  { owner, repo, branch? }
 *
 * Links a GitHub repo to an existing project and registers a deploy webhook.
 */
export async function linkRepo(c: Context) {
  const ctx = getRequestContext(c);
  const id = param(c, "id");
  await permission.assert(ctx, { resourceType: "project", resourceId: id, action: "write" });
  const { owner, repo, branch, installationId } = await c.req.json<{
    owner: string;
    repo: string;
    branch?: string;
    installationId?: number;
  }>();

  const result = await projectService.linkProjectRepo(ctx, id, { owner, repo, branch, installationId });

  if (!result.ok) {
    if (result.code === "not_found") return c.json({ error: "Project not found" }, 404);
    if (result.code === "app_not_installed") {
      return c.json(
        {
          success: false,
          error: "GitHub App is not installed for this account",
          install_url: result.installUrl,
          owner: result.owner,
        },
        400,
      );
    }
    return c.json({ success: false, error: result.message }, 400);
  }

  audit.recordAsync(auditContextFrom(c, ctx.organizationId, ctx.userId), {
    eventType: "project.updated",
    resourceType: "project",
    resourceId: id,
    after: {
      action: "git.linked",
      gitOwner: result.owner,
      gitRepo: result.repo,
      gitBranch: result.branch,
      webhookStrategy: result.strategy,
      autoDeploy: result.autoDeploy,
    },
  });

  return c.json({
    success: true,
    owner: result.owner,
    repo: result.repo,
    branch: result.branch,
    webhook_strategy: result.strategy,
    auto_deploy: result.autoDeploy,
  });
}

async function disableSharedWebhookIfUnused(
  ctx: RequestContext,
  organizationId: string,
  owner: string,
  repo: string,
  webhookId: number | null,
) {
  const repoProjects = await repos.project.findByGitRepo(owner, repo);
  if (repoProjects.some((p) => p.autoDeploy)) return;

  const projects = repoProjects.filter((p) => p.organizationId === organizationId);
  const hookId = webhookId ?? projects.find((p) => typeof p.webhookId === "number")?.webhookId;
  if (hookId) {
    await updateWebhook(ctx, owner, repo, hookId, {
      active: false,
    });
  }
}

export async function setAutoDeploy(c: Context) {
  const ctx = getRequestContext(c);
  const userId = ctx.userId;
  const organizationId = ctx.organizationId;
  const id = param(c, "id");
  await permission.assert(getRequestContext(c), { resourceType: "project", resourceId: id, action: "write" });
  const { enabled } = await c.req.json<{ enabled: boolean }>();
  const project = await repos.project.findById(id);
  try {
    assertResourceInOrg(project, "Project", organizationId, id);
  } catch {
    return c.json({ error: "Project not found" }, 404);
  }

  const owner = project.gitOwner;
  const repo = project.gitRepo;

  if (!owner || !repo) {
    return c.json({ success: false, error: "No repository linked" }, 400);
  }

  const strategy = await resolveWebhookStrategy(project);

  // In "none" mode, auto-deploy can't work - suggest options
  if (strategy === "none" && enabled) {
    return c.json(
      {
        success: false,
        error:
          "Set a webhook domain or expose this Openship API on a public URL to enable auto-deploy.",
        webhook_strategy: "none",
      },
      400,
    );
  }

  try {
    if (strategy === "app") {
      // GitHub App handles push events natively - just toggle the DB flag
      await repos.project.update(id, { autoDeploy: enabled });
    } else if (strategy === "domain") {
      // User has a verified domain - direct webhook delivery
      if (enabled) {
        // strategy === "domain" ⟹ webhookDomain is set (resolveWebhookStrategy).
    const webhookUrl = domainWebhookUrl(project.webhookDomain!);
        const webhookId = await ensureSharedWebhook(ctx, project, owner, repo, webhookUrl);
        if (!webhookId) {
          return c.json(
            {
              success: false,
              error: "Could not create webhook - you may not have admin access to this repository",
            },
            403,
          );
        }
        await repos.project.update(id, { autoDeploy: true });
      } else {
        await repos.project.update(id, { autoDeploy: false });
        await disableSharedWebhookIfUnused(ctx, project.organizationId, owner, repo, project.webhookId);
      }
    } else if (enabled) {
      // "repo" strategy - manage repo-level webhooks
      const webhookId = await ensureSharedWebhook(ctx, project, owner, repo);
      if (!webhookId) {
        return c.json(
          {
            success: false,
            error: "Could not create webhook - you may not have admin access to this repository",
          },
          403,
        );
      }
      await repos.project.update(id, { autoDeploy: true });
    } else {
      // Disable this environment. Keep the repo webhook while sibling environments still use it.
      await repos.project.update(id, { autoDeploy: false });
      await disableSharedWebhookIfUnused(ctx, project.organizationId, owner, repo, project.webhookId);
    }
  } catch (err) {
    const msg = safeErrorMessage(err);
    console.error(`[setAutoDeploy] strategy=${strategy} enabled=${enabled}:`, msg);

    if (msg.includes("No GitHub access token")) {
      return c.json(
        { success: false, error: "GitHub is not connected. Link your GitHub account first." },
        401,
      );
    }
    if (msg.includes("404")) {
      await repos.project.update(id, { webhookId: null, autoDeploy: false });
      return c.json(
        {
          success: false,
          error: "Webhook was deleted on GitHub. Try disabling and re-enabling auto-deploy.",
        },
        410,
      );
    }
    if (msg.includes("403")) {
      return c.json(
        {
          success: false,
          error: "You don't have permission to manage webhooks on this repository.",
        },
        403,
      );
    }
    if (msg.includes("422")) {
      return c.json(
        {
          success: false,
          error:
            "A webhook already exists for this repository. Try disabling and re-enabling auto-deploy.",
        },
        409,
      );
    }
    return c.json({ success: false, error: msg || "Failed to configure auto-deploy" }, 500);
  }

  const updated = await repos.project.findById(id);
  audit.recordAsync(auditContextFrom(c, organizationId, userId), {
    eventType: "project.updated",
    resourceType: "project",
    resourceId: id,
    after: {
      action: "autoDeploy.set",
      autoDeploy: updated?.autoDeploy ?? false,
      webhookStrategy: strategy,
    },
  });
  return c.json({
    success: true,
    auto_deploy: updated?.autoDeploy ?? false,
    webhook_strategy: strategy,
  });
}

/**
 * POST /projects/:id/webhook-domain  { domain: string | null }
 *
 * Set or clear the domain used for receiving GitHub webhooks.
 *
 * When a domain is set:
 *   1. Validates it belongs to this project and is verified
 *   2. Adds /_openship/hooks/ location to the domain's nginx config
 *   3. The webhook URL becomes https://{domain}/_openship/hooks/github
 *
 * When domain is null → clears the webhook domain (falls back to edge relay or none).
 */
export async function setWebhookDomain(c: Context) {
  const ctx = getRequestContext(c);
  const { userId, organizationId } = ctx;
  const id = param(c, "id");
  await permission.assert(getRequestContext(c), { resourceType: "project", resourceId: id, action: "write" });
  const { domain: hostname } = await c.req.json<{ domain: string | null }>();

  const project = await repos.project.findById(id);
  try {
    assertResourceInOrg(project, "Project", organizationId, id);
  } catch {
    return c.json({ error: "Project not found" }, 404);
  }

  // ── Clear webhook domain ────────────────────────────────────────────
  if (!hostname) {
    // If clearing, remove the webhook location from the old domain's nginx config
    if (project.webhookDomain) {
      await reRegisterDomainRoute(project, project.webhookDomain, false);
    }
    await repos.project.update(id, { webhookDomain: null });
    audit.recordAsync(auditContextFrom(c, organizationId, userId), {
      eventType: "project.updated",
      resourceType: "project",
      resourceId: id,
      after: { action: "webhookDomain.cleared" },
    });
    return c.json({ success: true, webhook_domain: null });
  }

  // ── Set webhook domain ──────────────────────────────────────────────
  // Verify the domain belongs to this project. Single-row lookup —
  // listByProject would scan every domain just to match one hostname.
  const dom = await repos.domain.findByHostnameForProject(id, hostname);
  if (!dom) {
    return c.json({ error: "Domain does not belong to this project" }, 400);
  }
  if (!dom.verified) {
    return c.json({ error: "Domain must be verified before it can receive webhooks" }, 400);
  }

  // Remove webhook location from the old domain if changing
  if (project.webhookDomain && project.webhookDomain !== hostname) {
    await reRegisterDomainRoute(project, project.webhookDomain, false);
  }

  // Add webhook location to the new domain's nginx config
  await reRegisterDomainRoute(project, hostname, true);

  await repos.project.update(id, { webhookDomain: hostname });

  const scheme = dom.sslStatus === "active" ? "https" : "http";
  const webhookUrl = domainWebhookUrl(hostname, scheme);

  audit.recordAsync(auditContextFrom(c, organizationId, userId), {
    eventType: "project.updated",
    resourceType: "project",
    resourceId: id,
    after: { action: "webhookDomain.set", webhookDomain: hostname },
  });
  return c.json({
    success: true,
    webhook_domain: hostname,
    webhook_url: webhookUrl,
  });
}

/**
 * Re-register a domain's nginx route with or without the webhook proxy location.
 * Reads the current deployment's service info to get the route target.
 */
async function reRegisterDomainRoute(
  project: {
    id: string;
    activeDeploymentId: string | null;
    port: number | null;
    cloudWorkspaceId: string | null;
    organizationId: string;
    webhookDomain: string | null;
    routeStrategy: string | null;
  },
  hostname: string,
  enableWebhook: boolean,
): Promise<void> {
  if (!project.activeDeploymentId) return;

  try {
    const dep = await repos.deployment.findById(project.activeDeploymentId);
    if (!dep) return;

    // Find the service deployment to get the container target.
    const svcDeps = await repos.service.listByDeployment(project.activeDeploymentId);
    const primarySvc = svcDeps.find((s) => s.ip);

    if (!primarySvc?.ip) return;

    const port = primarySvc.hostPort?.toString() || project.port?.toString() || "3000";
    const portNum = Number(port) || undefined;

    // Never point a public webhook route at a reserved control-plane/mgmt port on
    // the host loopback (admin API / dashboard / unauthenticated OpenResty mgmt
    // 9145) — a member with a verified domain could otherwise proxy their vhost
    // straight at an internal service. Mirrors resolveTargetUrl in
    // project-route.service.ts.
    if (isLoopbackHost(primarySvc.ip) && portNum !== undefined && isReservedLoopbackPort(portNum)) {
      console.warn(
        `[Webhook Domain] refusing reserved loopback upstream port ${portNum} for ${hostname}`,
      );
      return;
    }

    // Single reused path (deployment-scoped self-hosted routing / cloud). The
    // webhook-proxy is forced on/off explicitly here because the project row's
    // webhookDomain isn't updated yet at call time.
    await reconcileProjectRoutes(project, {
      deployment: dep,
      registers: [
        {
          hostname,
          targetUrl:
            buildUpstreamUrl({
              strategy: resolveRouteStrategy(project.routeStrategy),
              ip: primarySvc.ip,
              hostPort: primarySvc.hostPort ?? undefined,
              containerPort: project.port ?? portNum ?? 3000,
            }) ?? `http://${primarySvc.ip}:${port}`,
          port: portNum,
          isCustomDomain: false,
          webhook: enableWebhook,
        },
      ],
    });
  } catch (err) {
    console.error(`[Webhook Domain] Failed to update nginx for ${hostname}:`, err);
  }
}

export async function setBranch(c: Context) {
  const ctx = getRequestContext(c);
  const { userId, organizationId } = ctx;
  const id = param(c, "id");
  await permission.assert(getRequestContext(c), { resourceType: "project", resourceId: id, action: "write" });
  const { branch } = await c.req.json<{ branch: string }>();
  if (!branch) return c.json({ error: "branch is required" }, 400);
  const result = await projectService.setBranch(id, branch, organizationId);
  audit.recordAsync(auditContextFrom(c, organizationId, userId), {
    eventType: "project.updated",
    resourceType: "project",
    resourceId: id,
    after: { action: "branch.set", gitBranch: branch },
  });
  return c.json(result);
}

// ─── Build options ───────────────────────────────────────────────────────────

export async function setOptions(c: Context) {
  const ctx = getRequestContext(c);
  const { userId, organizationId } = ctx;
  const id = param(c, "id");
  await permission.assert(getRequestContext(c), { resourceType: "project", resourceId: id, action: "write" });
  const body = await c.req.json<Record<string, unknown>>();
  const result = await projectService.updateOptions(id, body, organizationId);
  audit.recordAsync(auditContextFrom(c, organizationId, userId), {
    eventType: "project.updated",
    resourceType: "project",
    resourceId: id,
    after: {
      action: "options.set",
      keys: Object.keys(body ?? {}),
    },
  });
  return c.json({ data: result });
}

/** GET /:id/commit-status — drift check for the "project outdated" banner. */
export async function getCommitStatus(c: Context) {
  const ctx = getRequestContext(c);
  const id = param(c, "id");
  await permission.assert(ctx, { resourceType: "project", resourceId: id, action: "read" });
  const status = await projectService.getProjectCommitStatus(ctx, id, ctx.organizationId);
  return c.json({ data: status });
}

// ─── Sleep mode ──────────────────────────────────────────────────────────────

export async function setSleepMode(c: Context) {
  const id = param(c, "id");
  await permission.assert(getRequestContext(c), { resourceType: "project", resourceId: id, action: "write" });
  // Read AFTER assert: permission.assert rebinds ctx.organizationId to the
  // resource's org for cross-org access (admin/grant). Capturing it before
  // would pass the stale session-active org → wrong-org 404 for multi-org
  // callers. ctx is the single source of truth post-assert.
  const { userId, organizationId } = getRequestContext(c);
  const { sleep_mode } = await c.req.json<{ sleep_mode: string }>();
  if (!sleep_mode) return c.json({ error: "sleep_mode is required" }, 400);
  const result = await projectService.setSleepMode(id, sleep_mode, organizationId);
  audit.recordAsync(auditContextFrom(c, organizationId, userId), {
    eventType: "project.updated",
    resourceType: "project",
    resourceId: id,
    after: { action: "sleepMode.set", sleepMode: sleep_mode },
  });
  return c.json(result);
}

// ─── Enable / Disable ────────────────────────────────────────────────────────

export async function enable(c: Context) {
  const id = param(c, "id");
  await permission.assert(getRequestContext(c), { resourceType: "project", resourceId: id, action: "write" });
  // Read org AFTER assert — it rebinds ctx to the resource's org for
  // cross-org access; the pre-assert value would be the stale active org.
  const { userId, organizationId } = getRequestContext(c);
  try {
    const result = await projectService.enableProject(id, organizationId);
    audit.recordAsync(auditContextFrom(c, organizationId, userId), {
      eventType: "project.updated",
      resourceType: "project",
      resourceId: id,
      after: { action: "enabled" },
    });
    return c.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to enable project";
    return c.json({ success: false, error: message }, 400);
  }
}

export async function disable(c: Context) {
  const id = param(c, "id");
  await permission.assert(getRequestContext(c), { resourceType: "project", resourceId: id, action: "write" });
  // Read org AFTER assert — it rebinds ctx to the resource's org for
  // cross-org access; the pre-assert value would be the stale active org.
  const { userId, organizationId } = getRequestContext(c);
  try {
    const result = await projectService.disableProject(id, organizationId);
    audit.recordAsync(auditContextFrom(c, organizationId, userId), {
      eventType: "project.updated",
      resourceType: "project",
      resourceId: id,
      after: { action: "disabled" },
    });
    return c.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to disable project";
    return c.json({ success: false, error: message }, 400);
  }
}

/** Re-run the managed free-domain edge-proxy sync (no rebuild). Clears the
 *  "Action Required" routing warning on success; returns the failure text
 *  (200, ok:false) when it still can't sync so the UI re-surfaces guidance. */
export async function retryRouting(c: Context) {
  const id = param(c, "id");
  await permission.assert(getRequestContext(c), { resourceType: "project", resourceId: id, action: "write" });
  const { userId, organizationId } = getRequestContext(c);
  try {
    const result = await projectService.retryProjectRouting(id, organizationId);
    if (result.ok) {
      audit.recordAsync(auditContextFrom(c, organizationId, userId), {
        eventType: "project.updated",
        resourceType: "project",
        resourceId: id,
        after: { action: "routing_retried" },
      });
    }
    return c.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to retry routing";
    return c.json({ ok: false, error: message }, 400);
  }
}

// ─── Project deployments ─────────────────────────────────────────────────────

export async function listDeployments(c: Context) {
  const ctx = getRequestContext(c);
  const { userId, organizationId } = ctx;
  const id = param(c, "id");
  await permission.assert(getRequestContext(c), { resourceType: "project", resourceId: id, action: "read" });
  const page = Number(c.req.query("page") ?? 1);
  const perPage = Number(c.req.query("perPage") ?? 20);
  const environment = c.req.query("environment") ?? undefined;
  const result = await projectService.listProjectDeployments(id, organizationId, {
    page,
    perPage,
    environment,
  });
  return c.json({
    data: result.rows,
    total: result.total,
    page: result.page,
    perPage: result.perPage,
  });
}

// ─── Deployment session ──────────────────────────────────────────────────────

export async function deploymentSession(c: Context) {
  const ctx = getRequestContext(c);
  const { userId, organizationId } = ctx;
  const id = param(c, "id");
  await permission.assert(getRequestContext(c), { resourceType: "project", resourceId: id, action: "read" });
  const result = await projectService.getLatestDeploymentSession(id, organizationId);
  return c.json(result);
}

// ─── Project info (enriched) ─────────────────────────────────────────────────

export async function getInfo(c: Context) {
  const ctx = getRequestContext(c);
  const { userId, organizationId } = ctx;
  const id = param(c, "id");
  await permission.assert(getRequestContext(c), { resourceType: "project", resourceId: id, action: "read" });
  const project = await projectService.getProject(id, organizationId);
  const environments = await projectService.listProjectEnvironments(id, organizationId);
  const hasServer = project.hasServer ?? project.productionMode === "host";
  const serviceRows = await repos.service.listByProject(id);
  const serviceCount = serviceRows.length;
  // Deployment shape, derived from the service rows (kind-discriminated) — not a
  // project column. The dashboard's config-edit path uses this to hydrate from
  // saved data without re-detecting the repo. Single-app → "app" (Dockerfile
  // single-apps aren't separately signalled at the project level today).
  // Use serviceKind so a row with a null/legacy `kind` still counts as compose
  // (matches the schema default and every other consumer) — a compose project
  // must never misreport as "app" just because a row lacks an explicit kind.
  const projectType: "app" | "services" | "monorepo" = serviceRows.some(
    (s) => serviceKind(s) === "monorepo",
  )
    ? "monorepo"
    : serviceRows.some((s) => serviceKind(s) === "compose")
      ? "services"
      : "app";

  // Build the "options" object the dashboard expects for build settings
  const options = {
    buildCommand: project.buildCommand ?? "",
    outputDirectory: project.outputDirectory ?? "",
    productionPaths: project.productionPaths ?? "",
    installCommand: project.installCommand ?? "",
    startCommand: hasServer ? (project.startCommand ?? "") : "",
    productionPort: hasServer ? String(project.port ?? 3000) : "",
    hasServer,
    hasBuild: project.hasBuild ?? true,
    rootDirectory: project.rootDirectory ?? "./",
    isLoading: false,
    error: null,
  };

  // No separate monorepoApps array: the Services API already returns all
  // services (compose + monorepo, discriminated by `kind`). The dashboard
  // filters that list when it wants only sub-apps. Adding a parallel array
  // here would re-introduce the duplication the fan-out unification removed.

  // Fetch domains for this project
  const rawDomains = await listProjectRouteRows(id);
  const routeState = await resolveProjectRouteState(project, { projectDomains: rawDomains });
  const publicEndpoints = routeState.publicEndpoints;
  let domains: Array<Domain & { domain: string; primary: boolean }> = rawDomains.map((d) => ({
    ...d,
    domain: d.hostname,
    primary: d.isPrimary,
  }));

  const verifiedPrimaryDomain =
    rawDomains.find((domain) => domain.isPrimary && domain.verified)?.hostname ??
    rawDomains.find((domain) => domain.verified)?.hostname ??
    null;
  refreshProjectFaviconIfStale(project, {
    hostname: verifiedPrimaryDomain,
  });

  return c.json({
    success: true,
    data: {
      project: {
        ...project,
        publicEndpoints,
        options,
        domains,
        serviceCount,
        hasMultipleServices: serviceCount > 1,
        projectType,
      },
      environments,
    },
  });
}

// ─── Connect custom domain ─────────────────────────────────────────────────────

export async function connectDomain(c: Context) {
  const ctx = getRequestContext(c);
  const { userId, organizationId } = ctx;
  const id = param(c, "id");
  await permission.assert(getRequestContext(c), { resourceType: "project", resourceId: id, action: "write" });
  const body = await c.req.json<{ domain: string; includeWww?: boolean; externalIngress?: boolean }>();

  if (!body.domain?.trim()) {
    return c.json({ success: false, error: "Domain is required" }, 400);
  }

  try {
    const result = await domainService.addDomain(getRequestContext(c), {
      projectId: id,
      hostname: body.domain.trim(),
      isPrimary: true,
      externalIngress: body.externalIngress ?? false,
    });

    audit.recordAsync(auditContextFrom(c, organizationId, userId), {
      eventType: "domain.added",
      resourceType: "domain",
      resourceId: result.domain.id,
      after: {
        projectId: id,
        hostname: result.domain.hostname,
        isPrimary: result.domain.isPrimary,
      },
    });

    return c.json({
      success: true,
      domain: result.domain,
      records: result.records,
    });
  } catch (err) {
    if (err instanceof Error) {
      return c.json({ success: false, error: err.message, message: err.message }, 400);
    }
    throw err;
  }
}
