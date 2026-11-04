import { serverSecurityOverview } from "./host-security";
import { env } from "../../config/env";
import type { AdvisoryFeedResult, SecurityOverview } from "@repo/contracts";
import { repos } from "@repo/db";
import type { ExecutionContext } from "../../../context";
import { listAuthorizedProjects } from "../../lib/authorized-projects";
import { isControlPlaneProject } from "../../lib/resource-access";
import { getAdvisoryFeed, type AdvisoryFeedState } from "./advisory-feed";
import { securityProbeKey, type SecurityInventory } from "./security-inventory";
import { securityObservationDue } from "./security-freshness";
import { buildProjectSecurityResult } from "./security-status";
import { annotateSecurityRefreshState } from "./security-refresh-state";
import { annotateSecurityRefreshAvailability } from "./security-refresh-availability";

/** Read current observations only. The existing scheduler owns bounded runtime inspection. */
export async function securityOverview(
  ctx: ExecutionContext,
  feed: AdvisoryFeedState,
): Promise<SecurityOverview> {
  const overview: SecurityOverview = { projects: [], pendingProjects: 0, unknownProjects: 0 };
  overview.checksEnabled = await repos.securityAdvisory.checksEnabled(ctx.organizationId);
  if (!overview.checksEnabled) return overview;
  const [projects, observations] = await Promise.all([
    listAuthorizedProjects(ctx, ctx.organizationId),
    repos.securityAdvisory.listByOrganization(ctx.organizationId),
  ]);
  const [scan, job, servers] = await Promise.all([
    repos.securityAdvisory.scanState(ctx.organizationId),
    repos.job.findByKey("security:advisories"),
    serverSecurityOverview(ctx, feed),
  ]);
  overview.scan = {
    status:
      scan?.status === "running" && Date.now() - scan.startedAt.getTime() > 5 * 60_000
        ? "interrupted"
        : (scan?.status ?? "pending"),
    startedAt: scan?.startedAt.toISOString() ?? null,
    finishedAt: scan?.finishedAt?.toISOString() ?? null,
    schedule: job?.cronExpression ?? "*/5 * * * *",
    schedulerEnabled: job?.enabled ?? true,
    runsWhileAppOpen: env.DEPLOY_MODE === "desktop",
  };
  overview.servers = servers;
  const stored = new Map(observations.map((row) => [row.projectId, row]));
  const probeKey = securityProbeKey(feed.security?.advisories ?? []);
  // Filter permissions before reading service names or returning any findings/counts.
  for (const project of projects) {
    if (project.deletionInProgress || isControlPlaneProject(project)) continue;
    const row = stored.get(project.id);
    if (!project.activeDeploymentId && !row?.autoRefresh) continue;
    let inventory = row?.inventory as SecurityInventory | null | undefined;
    if (
      !inventory ||
      row?.deploymentId !== project.activeDeploymentId ||
      inventory.deploymentId !== project.activeDeploymentId ||
      inventory.probeKey !== probeKey
    ) {
      overview.pendingProjects++;
      inventory = {
        deploymentId: project.activeDeploymentId,
        images: [],
        runtimes: [],
        unknownServices: [null],
        checkedAt: null,
      };
    } else if (securityObservationDue(row)) {
      overview.pendingProjects++;
    } else if (inventory.unknownServices.length) {
      overview.unknownProjects++;
    }
    const result = buildProjectSecurityResult(
      project.id,
      inventory,
      feed,
      row?.autoRefresh ?? false,
      new Map(),
    );
    if (securityObservationDue(row))
      result.findings.forEach((f) => {
        f.canRefresh = false;
      });
    overview.projects.push({ ...result, name: project.name, workspaceId: project.workspaceId });
  }
  const services = await repos.service.listByProjects(
    overview.projects.filter((p) => p.findings.length).map((p) => p.projectId),
  );
  for (const project of overview.projects) {
    const names = new Map((services.get(project.projectId) ?? []).map((s) => [s.id, s.name]));
    for (const finding of project.findings)
      finding.serviceName = finding.serviceId ? (names.get(finding.serviceId) ?? null) : null;
    if (project.findings.some((finding) => finding.canRefresh))
      await annotateSecurityRefreshAvailability(
        ctx,
        project,
        (stored.get(project.projectId)?.inventory as SecurityInventory | undefined)?.images,
      );
    await annotateSecurityRefreshState(project);
  }
  return overview;
}

/** Public feed stays shared; inventory is assembled separately for the caller's workspace. */
export async function organizationAdvisories(ctx: ExecutionContext): Promise<AdvisoryFeedResult> {
  const feed = await getAdvisoryFeed(ctx);
  return { ...feed, overview: await securityOverview(ctx, feed) };
}
