import { repos } from "@repo/db";
import { safeErrorMessage } from "@repo/core";
import { OperationError } from "@repo/contracts";
import type { ExecutionContext } from "../../../context";
import { presentProject } from "../../../projects";
import { authorization } from "../../lib/authorization";
import { refreshProjectFaviconIfStale } from "../../lib/favicon-detector";
import { fetchOrgCloudProjects } from "../../lib/cloud/projects";
import * as projectService from "./project.service";

/** The dashboard overview, reused by native and remote callers after list authorization. */
export async function getProjectHome(ctx: ExecutionContext) {
  const { userId, organizationId } = ctx;
  const restricted = !!ctx.tokenScope || ctx.role === "restricted";
  const accountView = ctx.scopeMode !== "fixed" && !restricted && !ctx.credential?.organizationId;

  // Surface a structured payload that includes the user's full org list +
  // a per-org project count. The dashboard uses this to render a
  // "projects in your other orgs" hint when the active org has zero
  // visible projects (prevents the common confusion of "I deployed
  // something but it doesn't show up" when the session active org is
  // a freshly-created empty team org).
  let result: {
    rows: Awaited<ReturnType<typeof projectService.listProjects>>["rows"];
    total: number;
  };
  try {
    result = await projectService.listProjects(organizationId, {
      page: 1,
      perPage: 100,
      ...(restricted && { canRead: (id: string) => authorization.checkPermissionOnResource(ctx, { resourceType: "project", resourceId: id, action: "read" }) }),
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
      throw new OperationError("Failed to load projects", 500, "LIST_FAILED", { success: false, message: msg });
    }
    return {
      success: true,
      projects: [],
      numbers: {
        total_projects: 0,
        total_active_projects: 0,
        total_deployments: 0,
        total_success_deployments: 0,
      },
      otherOrgs: [],
    };
  }

  // Enrich every project in ONE round trip — batched queries
  // instead of (4 × N) per-project. With 50 projects the old loop
  // fired 200+ SQL statements; this version fires a constant ≤6
  // regardless of project count. The dashboard derives "needs cloud
  // reconnect" client-side from `deployTarget === 'cloud'` +
  // CloudContext.connected — no duplicate server-side flag.
  const projectIds = result.rows.map((p) => p.id);
  const [
    enrichedProjectsResolved,
    latestByProject,
    primariesByProject,
    servicesByProject,
    deployStats,
  ] = await Promise.all([
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
      ...presentProject(enriched),
      latestDeploymentId: latest?.id ?? null,
      latestDeploymentStatus: latest?.status ?? null,
      latestDeploymentBlocked: projectService.deploymentIsBlocked(latest),
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
  if (accountView && result.total === 0) {
    try {
      const memberships = await repos.member.listByUser(userId);
      const otherOrgIds = memberships
        .map((m) => m.organizationId)
        .filter((id) => id !== organizationId);
      // Batch lookup names + project counts. Names come from one
      // findManyById; counts still go through projectService per org
      // (each is a SELECT COUNT — fine at N < 20 memberships).
      const orgs = await repos.organization.findManyById(otherOrgIds).catch(() => []);
      const orgsById = new Map(orgs.map((o) => [o.id, o]));
      otherOrgs = await Promise.all(
        otherOrgIds.map(async (otherOrgId) => {
          const context = await authorization.authorize({ ...ctx, organizationId: otherOrgId, scopeMode: "fixed" }, {
            resourceType: "project", resourceId: "*", action: "read", scope: "list",
          });
          const countResult = await projectService
            .listProjects(otherOrgId, {
              page: 1, perPage: 1,
              ...(context.role === "restricted" && { canRead: (id: string) => authorization.checkPermissionOnResource(context, { resourceType: "project", resourceId: id, action: "read" }) }),
            })
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
  if (accountView) {
    const cloud = await fetchOrgCloudProjects(organizationId);
    if (cloud.state === "merged") {
      const localIds = new Set(localProjects.map((p) => (p as { id: string }).id));
      const cloudProjects = cloud.projects
        .filter((p) => !localIds.has((p.id as string) ?? ""))
        .map((p) => ({ ...presentProject(p), source: "cloud" as const }));
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

  return {
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
  };
}
