import { findActiveDeployment } from "@repo/platform/engine/lib/active-deployment";
import type { ProjectControlSchemas } from "@repo/contracts";
import type { ResourceServices } from "../../../resource-operations";
import type { ProjectDependencies } from "../../../projects";

import { repos, type Project } from "@repo/db";
import { safeErrorMessage } from "@repo/core";
import { OperationError } from "@repo/contracts";
import type { ExecutionContext as RequestContext } from "../../../context";
import type { RuntimeAdapter } from "@repo/adapters";
import { presentProject } from "../../../projects";
import {
  enableProjectHook,
  disableProjectHook,
} from "../azure/azure.service";
import { failOperation } from "../../lib/operation-errors";
import { assertResourceInOrg } from "../../lib/resource-access";
import * as projectService from "./project.service";
import {
  updateWebhook,
  getAvailableStrategies,
  getRecentCommits,
  resolveDefaultBranch,
  resolveWebhookStrategy,
  listBranches as listGitHubBranches,
} from "../github/github.service";
import { resolveInstallUrl } from "../github/github.auth";
import { ensureSharedWebhook } from "./project-git-webhook";
import { withLiveProjectRuntimeMutation } from "../../lib/project-runtime-lock";
import { domainWebhookUrl } from "../../lib/public-url";
import { reconcileProjectRoutes } from "../../lib/route-apply.service";
import { compileProjectRoutingFields } from "../../lib/project-routing-fields";
import { isReservedLoopbackPort, pickPrimaryServiceId } from "../../lib/public-endpoints";
import { resolveLiveUpstreamUrl, resolveRouteStrategy } from "../../lib/upstream-url";
import { resolveDeploymentRuntimeForRead, disposeRuntime } from "../../lib/deployment-runtime";
import {
  loopbackHostPortFromUrl,
  observedLoopbackPublishFromUrl,
} from "../deployments/observed-host-port-claims";

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
    // Read for the project's compiled vercel.json rules below (and, inside
    // reconcileProjectRoutes, its proxy tunables): toggling the webhook location
    // rewrites the whole vhost, so anything this type omits is a field the toggle
    // deletes.
    routingConfig: Project["routingConfig"];
  },
  hostname: string,
  enableWebhook: boolean,
): Promise<void> {
  if (!project.activeDeploymentId) return;
  try {
    const dep = await findActiveDeployment(project);
    if (!dep) return;
    // Find the service deployment to get the container target. Prefer a row with
    // a container to inspect — a stored ip alone is just the last-known value.
    //
    // Via the same picker the access URL uses: these rows come back in insertion
    // (dependency) order, so the first one with a container was the database (#498).
    const svcDeps = await repos.service.listByDeployment(dep.id);
    const [projectServices, domainRows] = await Promise.all([
      repos.service.listByProject(project.id).catch(() => []),
      repos.domain.listByProject(project.id).catch(() => []),
    ]);
    const primaryId = pickPrimaryServiceId(
      projectServices.filter((s) => s.enabled),
      domainRows,
    );
    const primarySvc =
      svcDeps.find((s) => s.serviceId === primaryId && s.containerId) ??
      svcDeps.find((s) => s.containerId);
    if (!primarySvc?.containerId) return;
    // The port the app LISTENS on. `hostPort` is a publish, not a container port,
    // so it must not stand in for one — resolveLiveUpstreamUrl derives the host
    // side itself.
    const containerPort = project.port ?? 3000;
    const strategy = resolveRouteStrategy(project.routeStrategy);
    const stored = {
      ip: primarySvc.ip,
      hostPort: primarySvc.hostPort,
      hostPorts: primarySvc.hostPorts,
    };
    let runtime: RuntimeAdapter;
    try {
      ({ runtime } = await resolveDeploymentRuntimeForRead(dep));
    } catch (err) {
      console.warn(
        `[Webhook Domain] could not resolve the live runtime for ${hostname}; leaving its route unchanged: ${safeErrorMessage(err)}`,
      );
      return;
    }
    let targetUrl: string | null = null;
    try {
      targetUrl = await resolveLiveUpstreamUrl({
        strategy,
        runtime,
        containerId: primarySvc.containerId,
        containerPort,
        stored,
        requireLiveObservation: true,
      });
    } finally {
      disposeRuntime(runtime);
    }
    if (!targetUrl) return;
    // Never point a public webhook route at a reserved control-plane/mgmt port on
    // the host loopback (admin API / dashboard / unauthenticated OpenResty mgmt
    // 9145) — a member with a verified domain could otherwise proxy their vhost
    // straight at an internal service. Mirrors resolveTargetUrl in
    // project-route.service.ts.
    let upstreamPort: number | undefined;
    try {
      const parsed = new URL(targetUrl);
      upstreamPort = parsed.port ? Number(parsed.port) : parsed.protocol === "https:" ? 443 : 80;
    } catch {
      return;
    }
    const loopbackPort = loopbackHostPortFromUrl(targetUrl);
    if (loopbackPort && isReservedLoopbackPort(loopbackPort)) {
      console.warn(
        `[Webhook Domain] refusing reserved loopback upstream port ${loopbackPort} for ${hostname}`,
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
          ...compileProjectRoutingFields(project.routingConfig),
          hostname,
          targetUrl,
          port: upstreamPort ?? containerPort,
          isCustomDomain: false,
          webhook: enableWebhook,
          ...(() => {
            const observed = observedLoopbackPublishFromUrl({
              targetUrl,
              serviceId: primarySvc.serviceId,
              containerId: primarySvc.containerId,
              containerPort,
            });
            return observed ? { observedLoopbackPublishes: [observed] } : {};
          })(),
        },
      ],
    });
  } catch (err) {
    console.error(`[Webhook Domain] Failed to update nginx for ${hostname}:`, err);
  }
}
export function createProjectGitOperations(
  recordAudit: ProjectDependencies["recordAudit"],
): Pick<
  ResourceServices<typeof ProjectControlSchemas>,
  | "getGitInfo"
  | "listBranches"
  | "linkRepo"
  | "setReleaseImageSource"
  | "setAutoDeploy"
  | "setWebhookDomain"
> {
  return {
    async getGitInfo(ctx, id) {
      const userId = ctx.userId;
      const organizationId = ctx.organizationId;
      const info = await projectService.getGitInfo(id, organizationId);
      // No repo linked yet — the normal state for upload/local projects, not a
      // failure. The `code` lets the client render an inline "connect a repo" empty
      // state instead of a full-page repo-not-found takeover (see GitSettings).
      if (!info.gitOwner || !info.gitRepo) {
        return { success: false, error: "No repository connected", code: "NO_REPOSITORY" };
      }
      // Same resolver the project payload (`/info`) uses, so the Source tab and the
      // Overview can't answer "is auto-deploy wired up?" differently.
      const { strategy, webhookActive, installationInstalled } =
        await projectService.resolveProjectWebhookState(organizationId, info);
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
      const installUrl =
        strategy === "app" && !installationInstalled
          ? (await resolveInstallUrl(ctx)).url
          : undefined;
      return {
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
        install_url: installUrl,
        default_rollback_strategy: info.defaultRollbackStrategy ?? "git",
      };
    },
    async listBranches(ctx, id, input) {
      const { organizationId } = ctx;
      const info = await projectService.getGitInfo(id, organizationId);
      if (!info.gitOwner || !info.gitRepo) {
        return failOperation({ success: false, error: "No repository connected" }, 400);
      }
      const { branches, page, perPage, hasMore } = await listGitHubBranches(ctx, info.gitOwner, info.gitRepo, input);
      return {
        data: branches.map((branch) => ({ name: branch.name, sha: branch.commit.sha, protected: branch.protected })),
        pagination: { page, perPage, hasMore },
      };
    },
    async linkRepo(ctx, id, input) {
      const { owner, repo, branch, installationId } = input;
      const result = await projectService.linkProjectRepo(ctx, id, {
        owner,
        repo,
        branch,
        installationId,
      });
      if (!result.ok) {
        if (result.code === "not_found") return failOperation({ error: "Project not found" }, 404);
        if (result.code === "app_not_installed") {
          return failOperation(
            {
              success: false,
              error: "GitHub App is not installed for this account",
              install_url: result.installUrl,
              owner: result.owner,
            },
            400,
          );
        }
        return failOperation({ success: false, error: result.message }, 400);
      }
      recordAudit(ctx, {
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
      return {
        success: true,
        owner: result.owner,
        repo: result.repo,
        branch: result.branch,
        webhook_strategy: result.strategy,
        auto_deploy: result.autoDeploy,
      };
    },
    async setReleaseImageSource(ctx, id, input) {
      const before = await repos.project.findById(id);
      const body = input;
      const project = await projectService.setProjectReleaseImageSource(
        id,
        ctx.organizationId,
        body,
      );
      // The transition clears this group's push automation. If nobody else in the
      // organization uses the shared repo hook, disable it remotely as cleanup.
      if (before?.gitOwner && before.gitRepo && before.autoDeploy) {
        await disableSharedWebhookIfUnused(
          ctx,
          ctx.organizationId,
          before.gitOwner,
          before.gitRepo,
          before.webhookId,
        ).catch(() => {});
      }
      recordAudit(ctx, {
        eventType: "project.updated",
        resourceType: "project",
        resourceId: id,
        before: {
          gitProvider: before?.gitProvider ?? null,
          gitOwner: before?.gitOwner ?? null,
          gitRepo: before?.gitRepo ?? null,
        },
        after: {
          action: "release-image-source.set",
          gitProvider: project.gitProvider,
          releaseSource: project.releaseSource,
        },
      });
      return presentProject(project);
    },
    async setAutoDeploy(ctx, id, input) {
      const userId = ctx.userId;
      const organizationId = ctx.organizationId;
      const { enabled } = input;
      const response = await withLiveProjectRuntimeMutation(id, async (project) => {
        try {
          assertResourceInOrg(project, "Project", organizationId, id);
        } catch {
          return failOperation({ error: "Project not found" }, 404);
        }
        const owner = project.gitOwner;
        const repo = project.gitRepo;
        if (!owner || !repo) {
          return failOperation({ success: false, error: "No repository linked" }, 400);
        }
        // Azure DevOps projects manage their own Service Hook subscription —
        // the GitHub webhook-strategy machinery does not apply.
        if ((project.gitProvider ?? "").toLowerCase() === "azure") {
          const adoProject = project.gitProject;
          if (!adoProject) {
            return failOperation(
              { success: false, error: "Project has no Azure DevOps project set" },
              400,
            );
          }
          try {
            if (enabled) {
              await enableProjectHook(ctx, id);
            } else {
              await disableProjectHook(ctx, id);
            }
          } catch (err) {
            if (err instanceof OperationError) throw err;
            const msg = safeErrorMessage(err);
            console.error(`[setAutoDeploy] azure enabled=${enabled}:`, msg);
            return failOperation({ success: false, error: msg }, 502);
          }
          const updated = await repos.project.findById(id);
          recordAudit(ctx, {
            eventType: "project.updated",
            resourceType: "project",
            resourceId: id,
            after: {
              action: "autoDeploy.set",
              autoDeploy: updated?.autoDeploy ?? false,
              webhookStrategy: "azure-service-hook",
            },
          });
          return {
            success: true,
            auto_deploy: updated?.autoDeploy ?? false,
            webhook_strategy: "azure-service-hook",
          };
        }
        const strategy = await resolveWebhookStrategy(project, organizationId);
        // In "none" mode, auto-deploy can't work - suggest options
        if (strategy === "none" && enabled) {
          return failOperation(
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
                return failOperation(
                  {
                    success: false,
                    error:
                      "Could not create webhook - you may not have admin access to this repository",
                  },
                  403,
                );
              }
              await repos.project.update(id, { autoDeploy: true });
            } else {
              await repos.project.update(id, { autoDeploy: false });
              await disableSharedWebhookIfUnused(
                ctx,
                project.organizationId,
                owner,
                repo,
                project.webhookId,
              );
            }
          } else if (enabled) {
            // "repo" strategy - manage repo-level webhooks
            const webhookId = await ensureSharedWebhook(ctx, project, owner, repo);
            if (!webhookId) {
              return failOperation(
                {
                  success: false,
                  error:
                    "Could not create webhook - you may not have admin access to this repository",
                },
                403,
              );
            }
            await repos.project.update(id, { autoDeploy: true });
          } else {
            // Disable this environment. Keep the repo webhook while sibling environments still use it.
            await repos.project.update(id, { autoDeploy: false });
            await disableSharedWebhookIfUnused(
              ctx,
              project.organizationId,
              owner,
              repo,
              project.webhookId,
            );
          }
        } catch (err) {
          if (err instanceof OperationError) throw err;
          const msg = safeErrorMessage(err);
          console.error(`[setAutoDeploy] strategy=${strategy} enabled=${enabled}:`, msg);
          // Structured denial from the GitHub access gate. The branches below sniff
          // `msg` for GitHub's own "GitHub API error (403): …" shape, which this error
          // does not have — its status lives on the object, so without this it would
          // fall through to a generic 500 and hide an actionable "ask an owner for
          // access" message behind "something went wrong".
          if (
            (
              err as {
                code?: unknown;
              } | null
            )?.code === "GITHUB_ACCESS_DENIED"
          ) {
            return failOperation({ success: false, error: msg }, 403);
          }
          if (msg.includes("No GitHub access token")) {
            return failOperation(
              { success: false, error: "GitHub is not connected. Link your GitHub account first." },
              401,
            );
          }
          if (msg.includes("404")) {
            await repos.project.update(id, { webhookId: null, autoDeploy: false });
            return failOperation(
              {
                success: false,
                error: "Webhook was deleted on GitHub. Try disabling and re-enabling auto-deploy.",
              },
              410,
            );
          }
          if (msg.includes("403")) {
            return failOperation(
              {
                success: false,
                error: "You don't have permission to manage webhooks on this repository.",
              },
              403,
            );
          }
          if (msg.includes("422")) {
            return failOperation(
              {
                success: false,
                error:
                  "A webhook already exists for this repository. Try disabling and re-enabling auto-deploy.",
              },
              409,
            );
          }
          return failOperation(
            { success: false, error: msg || "Failed to configure auto-deploy" },
            500,
          );
        }
        const updated = await repos.project.findById(id);
        recordAudit(ctx, {
          eventType: "project.updated",
          resourceType: "project",
          resourceId: id,
          after: {
            action: "autoDeploy.set",
            autoDeploy: updated?.autoDeploy ?? false,
            webhookStrategy: strategy,
          },
        });
        return {
          success: true,
          auto_deploy: updated?.autoDeploy ?? false,
          webhook_strategy: strategy,
        };
      });
      return response ?? failOperation({ error: "Project is being deleted" }, 409);
    },
    async setWebhookDomain(ctx, id, input) {
      const { userId, organizationId } = ctx;
      const { domain: hostname } = input;
      const initialProject = await repos.project.findById(id);
      try {
        assertResourceInOrg(initialProject, "Project", organizationId, id);
      } catch {
        return failOperation({ error: "Project not found" }, 404);
      }
      const result = await withLiveProjectRuntimeMutation(id, async (project) => {
        assertResourceInOrg(project, "Project", organizationId, id);
        // ── Clear webhook domain ──────────────────────────────────────────
        if (!hostname) {
          // If clearing, remove the webhook location from the old domain's nginx config
          if (project.webhookDomain) {
            await reRegisterDomainRoute(project, project.webhookDomain, false);
          }
          await repos.project.update(id, { webhookDomain: null });
          recordAudit(ctx, {
            eventType: "project.updated",
            resourceType: "project",
            resourceId: id,
            after: { action: "webhookDomain.cleared" },
          });
          return { success: true, webhook_domain: null };
        }
        // ── Set webhook domain ────────────────────────────────────────────
        // Verify the domain belongs to this project. Single-row lookup —
        // listByProject would scan every domain just to match one hostname.
        const dom = await repos.domain.findByHostnameForProject(id, hostname);
        if (!dom) {
          return failOperation({ error: "Domain does not belong to this project" }, 400);
        }
        if (!dom.verified) {
          return failOperation(
            { error: "Domain must be verified before it can receive webhooks" },
            400,
          );
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
        recordAudit(ctx, {
          eventType: "project.updated",
          resourceType: "project",
          resourceId: id,
          after: { action: "webhookDomain.set", webhookDomain: hostname },
        });
        return {
          success: true,
          webhook_domain: hostname,
          webhook_url: webhookUrl,
        };
      });
      return result ?? failOperation({ error: "Project not found" }, 404);
    },
  };
}
