import type { ProjectControlSchemas } from "@repo/contracts";
import type { ResourceServices } from "../../../resource-operations";
import type { ProjectDependencies } from "../../../projects";

import { repos, type Domain } from "@repo/db";
import { resolveProjectVolumes } from "@repo/core";
import { presentProject } from "../../../projects";
import { authorization } from "../../lib/authorization";
import * as projectService from "./project.service";
import { deploymentWorkload } from "../deployments/deployment-class";
import { serviceKind } from "../../lib/deployable-service";
import { maskDeploymentEnv } from "../../lib/secret-env";
import { listProjectRouteRows, resolveProjectRouteState } from "../domains/project-route.service";
import { refreshProjectFaviconIfStale } from "../../lib/favicon-detector";
import { pickCanonicalDomainRow, resolveProjectAccess } from "../../lib/public-endpoints";

export function createProjectInspectionOperations(
  recordAudit: ProjectDependencies["recordAudit"],
): Pick<
  ResourceServices<typeof ProjectControlSchemas>,
  "getInfo" | "listDeployments" | "deploymentSession"
> {
  return {
    async getInfo(ctx, id) {
      const { userId, organizationId } = ctx;
      const project = await projectService.getProject(id, organizationId);
      const environments = await projectService.listProjectEnvironments(
        id,
        organizationId,
        (projectId) =>
          authorization.checkPermissionOnResource(ctx, {
            resourceType: "project",
            resourceId: projectId,
            action: "read",
          }),
      );
      // The LATEST deployment, for the blocked-deploy flag. `getProject` resolves the
      // ACTIVE one, which by construction is never a blocked deploy — so without this
      // the detail page's status pill couldn't show a blocker that the project list
      // (which already fetches `latest`) does show. One query on a detail read.
      const latestDeployment = await repos.deployment.findLatestByProject(id).catch(() => null);
      const hasServer = project.hasServer ?? project.productionMode === "host";
      // The resolved runtime workload (web | worker | static). A worker and a web app
      // both run a long-lived process (start command + volumes), but only a web app
      // listens on a port; a static site does neither (#538-B).
      const workloadType = deploymentWorkload(project);
      const runsProcess = workloadType !== "static";
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
        startCommand: runsProcess ? (project.startCommand ?? "") : "",
        productionPort: workloadType === "web" ? String(project.port ?? 3000) : "",
        hasServer,
        workloadType,
        hasBuild: project.hasBuild ?? true,
        rootDirectory: project.rootDirectory ?? "./",
        // Two fields, because "" and "inherits the framework default" are different
        // answers: `volumes` is what the project declared (null = not declared) and
        // `resolvedVolumes` is what a deploy would actually mount, so the editor can
        // show the inherited value as a placeholder instead of pretending it's unset.
        volumes: (project.volumes as string[] | null) ?? null,
        resolvedVolumes: runsProcess
          ? resolveProjectVolumes(project.volumes as string[] | null, project.framework)
          : [],
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
      let domains: Array<
        Domain & {
          domain: string;
          primary: boolean;
        }
      > = rawDomains.map((d) => ({
        ...d,
        domain: d.hostname,
        primary: d.isPrimary,
      }));
      refreshProjectFaviconIfStale(project, {
        hostname: pickCanonicalDomainRow(rawDomains)?.hostname ?? null,
      });
      // One server-computed access URL for every client surface. Derived from ALL
      // domain rows (service-scoped included, which the project-level publicEndpoints
      // resolver drops) + the effective deploy target, so a multi-service project
      // with only service-scoped domains no longer falls back to localhost.
      // One rule for where this project runs, shared with the cards. `null` means nothing
      // is bound and nothing has deployed — no target yet; the access URL still resolves
      // against "local" as it always has, since that's the box answering this request.
      const { deployTarget, serverId } = await projectService.resolveProjectDeployTarget(project);
      const access = resolveProjectAccess({
        rows: rawDomains,
        target: deployTarget ?? "local",
        port: project.port ?? null,
      });
      // Push auto-deploy state travels WITH the project payload, not only with
      // `/git`. The Overview renders "auto-deploy / webhook" from this read, while
      // `/git` is fetched lazily — only when the Source tab mounts, because it also
      // calls GitHub for recent commits. A project whose pushes really did deploy
      // therefore rendered "off" on every cold load (`autoDeploy` is exactly what
      // webhook-push.ts gates on). Skipped for repo-less projects so an upload/app
      // project pays none of it.
      const webhookState =
        project.gitOwner && project.gitRepo
          ? await projectService.resolveProjectWebhookState(organizationId, {
              ...project,
              deployTarget,
            })
          : null;
      return {
        project: {
          ...presentProject(project),
          publicEndpoints,
          access,
          options,
          domains,
          serviceCount,
          hasMultipleServices: serviceCount > 1,
          projectType,
          // The saved deploy target, same shape the LIST emits. The deploy wizard hydrates
          // from this payload: without it, opening a saved project kept
          // DEFAULT_CONFIG.deployTarget ("cloud") and submitted that as the destination for
          // a project the operator had never sent to the cloud. `null` = no target yet, and
          // the wizard then seeds a validated one instead of inheriting a guess.
          deployTarget,
          serverId,
          // Same two fields the project LIST provides, so `getProjectStatus` reads
          // identically on the detail page and the cards.
          latestDeploymentId: latestDeployment?.id ?? null,
          latestDeploymentStatus: latestDeployment?.status ?? null,
          latestDeploymentBlocked: projectService.deploymentIsBlocked(latestDeployment),
          // `autoDeploy` itself already rides along in `...project` (the column).
          webhookStrategy: webhookState?.strategy ?? null,
          webhookActive: webhookState?.webhookActive ?? false,
        },
        environments,
      };
    },
    async listDeployments(ctx, id, input = {}) {
      const { userId, organizationId } = ctx;
      const page = Number(input.page ?? 1);
      const perPage = Number(input.perPage ?? 20);
      const environment = input.environment ?? undefined;
      const result = await projectService.listProjectDeployments(id, organizationId, {
        page,
        perPage,
        environment,
        status: input.status,
        search: input.search,
      });
      return {
        // #336: mask meta.composeServices[].environment (twin of deployment.controller list).
        data: result.rows.map(maskDeploymentEnv),
        total: result.total,
        page: result.page,
        perPage: result.perPage,
      };
    },
    async deploymentSession(ctx, id) {
      const { userId, organizationId } = ctx;
      const result = await projectService.getLatestDeploymentSession(id, organizationId);
      return result;
    },
  };
}
