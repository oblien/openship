/**
 * Unified update scanner.
 *
 * ONE channel for "is anything out of date?" across every updatable entity —
 * and every entity is a project row (git projects, release/dist projects, the
 * self-app, webmail, installed template apps). The scan iterates the org's
 * projects, runs the SINGLE drift resolver (`getProjectCommitStatus`, which
 * already dispatches commit | release | image), and caches the result in
 * `update_status` so the home Updates block + Apps tab read a cheap table
 * instead of recomputing drift (registry/GitHub calls) on every page load.
 *
 * There is deliberately no second detector: the client no longer checks GitHub
 * in the browser for the self-app — it reads this scan's result.
 */

import { ValidationError } from "@repo/core";
import { repos, type NewUpdateStatus, type Project } from "@repo/db";
import type { RequestContext } from "../../lib/request-context";
import { assertResourceInOrg } from "../../lib/controller-helpers";
import { getProjectCommitStatus } from "../projects/project-crud.service";
import { redeployBuildSession } from "../deployments/build.service";

/** The union `getProjectCommitStatus` returns (widened for normalization). */
type DriftStatus = Awaited<ReturnType<typeof getProjectCommitStatus>>;

/**
 * Map a resolver result onto an `update_status` upsert payload. Returns null for
 * unsupported entities (local/upload/no-remote projects) so they're skipped.
 */
function toUpsert(
  project: Project,
  status: DriftStatus,
): Omit<NewUpdateStatus, "id"> | null {
  if (!status.supported) return null;

  const base = {
    organizationId: project.organizationId,
    projectId: project.id,
    behind: status.behind,
    latestInProgress: status.latestInProgress,
    checkedAt: new Date(),
  };

  if (status.mode === "commit") {
    return {
      ...base,
      kind: "commit",
      currentLabel: status.deployedSha ? status.deployedSha.slice(0, 7) : null,
      latestLabel: status.latestSha ? status.latestSha.slice(0, 7) : null,
      detail: { branch: status.branch, latestMessage: status.latestMessage ?? null },
    };
  }
  if (status.mode === "release") {
    return {
      ...base,
      kind: "release",
      currentLabel: status.currentVersion ?? null,
      latestLabel: status.latestVersion ?? null,
      detail: { pinned: status.pinned },
    };
  }
  // image
  return {
    ...base,
    kind: "image",
    currentLabel: null,
    latestLabel: null,
    detail: { services: status.services },
  };
}

export interface ScanSummary {
  scanned: number;
  supported: number;
  behind: number;
}

/**
 * Scan every project in an org, refresh the `update_status` cache. `ctx` is only
 * used to satisfy the resolver's org-scoped read (the scan is org-level, not
 * per-user). Best-effort per project — one failure never aborts the sweep.
 */
export async function scanOrganizationUpdates(
  ctx: RequestContext | null,
  organizationId: string,
): Promise<ScanSummary> {
  // Large perPage → effectively "all projects" for a single org.
  const { rows } = await repos.project.listByOrganization(organizationId, { perPage: 1000 });
  return scanProjects(ctx, rows);
}

/**
 * Instance-wide sweep for the scheduled `updates:scan` job — every project
 * across all orgs. No user session, so `ctx` is null and git-commit projects
 * are skipped (they're checked on-demand from their page); release/image/self
 * drift (the apps/mail/self surface) is fully covered.
 */
export async function scanInstanceUpdates(): Promise<ScanSummary> {
  const rows = await repos.project.listAllForScan();
  return scanProjects(null, rows);
}

async function scanProjects(ctx: RequestContext | null, rows: Project[]): Promise<ScanSummary> {
  let supported = 0;
  let behind = 0;

  for (const project of rows) {
    try {
      const status = await getProjectCommitStatus(ctx, project.id, project.organizationId);
      const upsert = toUpsert(project, status);
      if (!upsert) {
        // Unsupported now (e.g. source changed) — drop any stale cached row.
        await repos.updateStatus.deleteByProject(project.id).catch(() => {});
        continue;
      }
      supported += 1;
      if (upsert.behind) behind += 1;
      await repos.updateStatus.upsert(upsert);
    } catch {
      /* best-effort: skip this project, keep scanning */
    }
  }

  return { scanned: rows.length, supported, behind };
}

/**
 * Apply the available update to a project (app / git / release / self-app). Runs
 * a redeploy with the `update` trigger — which force-pulls image tags and
 * recreates every image service, and (for release/git projects) rolls forward
 * to the latest version/commit — after firing a pre-deploy backup. The existing
 * rollback-orchestrator auto-archive gives one-click revert. Returns the new
 * deployment id so the UI can follow build progress.
 */
export async function applyProjectUpdate(ctx: RequestContext, projectId: string) {
  const project = await repos.project.findById(projectId);
  assertResourceInOrg(project, "Project", ctx.organizationId, projectId);
  if (!project.activeDeploymentId) {
    throw new ValidationError("Deploy this project before updating it.");
  }
  const result = await redeployBuildSession(ctx, project.activeDeploymentId, {
    trigger: "update",
    preDeployBackup: true,
  });
  // Refresh this project's cached status now that an update is in flight.
  await scanProjects(ctx, [project]).catch(() => {});
  return result;
}

/** Cached update statuses for an org, enriched with project display fields. */
export async function listOrganizationUpdates(
  organizationId: string,
  opts?: { behindOnly?: boolean },
) {
  const rows = opts?.behindOnly
    ? await repos.updateStatus.listBehindByOrg(organizationId)
    : await repos.updateStatus.listByOrg(organizationId);

  const { rows: projects } = await repos.project.listByOrganization(organizationId, {
    perPage: 1000,
  });
  const byId = new Map(projects.map((p) => [p.id, p]));

  return rows.map((r) => {
    const p = byId.get(r.projectId);
    return {
      projectId: r.projectId,
      name: p?.name ?? r.projectId,
      slug: p?.slug ?? null,
      isApp: p?.isApp ?? false,
      appTemplateId: p?.appTemplateId ?? null,
      kind: r.kind,
      behind: r.behind,
      latestInProgress: r.latestInProgress,
      currentLabel: r.currentLabel,
      latestLabel: r.latestLabel,
      detail: r.detail,
      checkedAt: r.checkedAt,
    };
  });
}
