/** Application composition shared by the HTTP process and each owned native worker. */
import { AppError, CLOUD_UNREACHABLE_CODE } from "@repo/core";
import { isCreateDeploymentResult, isDeployment } from "@repo/contracts";
import { createPlatform, type PlatformKernel } from "@repo/platform";
import { authorization } from "./authorization";
import { audit } from "./audit-emitter";
import { resolveProjectAuthority } from "./cloud/project-authority";
import { cloudFetchAsOrgOwner } from "./cloud/transport";
import * as buildService from "../modules/deployments/build.service";
import * as deploymentService from "../modules/deployments/deployment.service";
import * as buildStatusService from "../modules/deployments/build-status.service";
import { triggerReconcile } from "../modules/deployments/reconcile.service";
import { projectDependencies } from "../modules/projects/project.operations";
import { buildDependencies } from "../modules/deployments/build.operations";
import { sourceDependencies } from "../modules/projects/folder/folder.operations";
import { serviceDependencies } from "../modules/services/service.operations";
import { domainDependencies } from "../modules/domains/domain.operations";
import { dnsDependencies } from "../modules/dns/dns.operations";
import { credentialDependencies } from "../modules/credentials/credential.operations";
import { serverDependencies } from "../modules/system/server.operations";
import { systemDependencies } from "../modules/system/system.operations";
import { getDeploymentPendingActions } from "../modules/projects/pending-actions.service";
import { deploymentSslOperations } from "../modules/deployments/ssl.operations";
import { appDependencies } from "../modules/apps/app.operations";
import { backupDestinationDependencies } from "../modules/backup-destinations/destination.operations";
import { backupDependencies } from "../modules/backups/backup.operations";

import { jobDependencies } from "../modules/jobs/job.operations";

import { analyticsDependencies } from "../modules/analytics/analytics.operations";

import { issuesDependencies } from "../modules/issues/issues.operations";

import { notificationsDependencies } from "../modules/notifications/notifications.operations";

import { settingsDependencies } from "../modules/settings/settings.operations";

import { auditDependencies } from "../modules/audit/audit.operations";

import { updatesDependencies } from "../modules/updates/updates.operations";

import { webhooksDependencies } from "../modules/incoming-webhooks/incoming.operations";

import { tokensDependencies } from "../modules/tokens/token.operations";

import { permissionsDependencies } from "../modules/permissions/permissions.operations";

import { githubDependencies } from "../modules/github/github.operations";

import { noticesDependencies } from "../modules/notices/notice.operations";

import { billingDependencies } from "../modules/billing/billing.operations";

let platform: PlatformKernel | undefined;

export function getPlatformKernel(): PlatformKernel {
  return (platform ??= createPlatform({
    authorization,
    projects: projectDependencies,
    builds: buildDependencies,
    sources: sourceDependencies,
    services: serviceDependencies,
    domains: domainDependencies,
    dns: dnsDependencies,
    credentials: credentialDependencies,
    servers: serverDependencies,
    system: systemDependencies,
    apps: appDependencies,
    backupDestinations: backupDestinationDependencies,
    backups: backupDependencies,
    billing: billingDependencies,
    notices: noticesDependencies,
    github: githubDependencies,
    permissions: permissionsDependencies,
    tokens: tokensDependencies,
    webhooks: webhooksDependencies,
    updates: updatesDependencies,
    audit: auditDependencies,
    settings: settingsDependencies,
    notifications: notificationsDependencies,
    issues: issuesDependencies,
    analytics: analyticsDependencies,
    jobs: jobDependencies,
    resources: {
      ssl: deploymentSslOperations,
      controls: {
        containerInfo: (ctx, id) => deploymentService.getContainerInfo(id, ctx.organizationId),
        containerUsage: (ctx, id) => deploymentService.getContainerUsage(id, ctx.organizationId),
        pendingActions: async (ctx, id) => ({ actions: await getDeploymentPendingActions(id, ctx.organizationId) }),
      },
      get: (...args) => deploymentService.getDeployment(...args),
      list: (...args) => deploymentService.listDeployments(...args),
      logs: (...args) => deploymentService.getDeploymentLogs(...args),
      buildStatus: (...args) => buildStatusService.getBuildSessionStatus(...args),
      reconcile: (...args) => triggerReconcile(...args),
      restorePlan: (...args) => deploymentService.previewRestore(...args),
      assertRepositoryAccess: (...args) => deploymentService.assertGitHubAccessForDeployment(...args),
      rollback: (...args) => deploymentService.rollbackDeployment(...args),
      cancel: (...args) => buildService.cancelBuildSession(...args),
      respond: (...args) => buildService.respondToPrompt(...args),
      redeploy: (...args) => buildService.redeployBuildSession(...args),
      pin: (...args) => deploymentService.setDeploymentPin(...args),
      keep: (...args) => deploymentService.keepDeployment(...args),
      reject: (...args) => deploymentService.rejectDeployment(...args),
      remove: (...args) => deploymentService.deleteDeployment(...args),
      restart: (...args) => deploymentService.restartDeployment(...args),
      skipPortCheck: (...args) => deploymentService.skipPortCheck(...args),
      subscribe: (...args) => buildService.subscribeToBuildSession(...args),
    },
    trigger: (ctx, input) => buildService.triggerDeployment(ctx, input),
    // Preserve the HTTP presentation, including masking, and detach all nested
    // objects. Native callers get the same ISO dates/JSON values as HTTP callers.
    present(deployment) {
      const data: unknown = JSON.parse(
        JSON.stringify(deploymentService.presentDeployment(deployment)),
      );
      if (!isDeployment(data))
        throw new AppError("Invalid deployment presentation", 500, "INVALID_DEPLOYMENT_RESPONSE");
      return data;
    },
    async forward(ctx, input, options) {
      const source = await resolveProjectAuthority(
        input.projectId,
        ctx.organizationId,
        options.projectSource,
      );
      if (source !== "cloud") return null;
      // Current links bind an OWNER ACCOUNT, not a local org to a cloud org.
      // Sending that owner's unbound session would lose a fixed tenant scope.
      // Use a scoped client directly on the canonical cloud instance until
      // cloud links have a verified organization mapping.
      if (ctx.scopeMode === "fixed") {
        throw new AppError(
          "This cloud link has no tenant mapping. Connect the SDK directly to the cloud instance with its organizationId.",
          409,
          "CLOUD_SCOPE_UNAVAILABLE",
        );
      }
      const response = await cloudFetchAsOrgOwner(ctx.organizationId, "/api/deployments", {
        method: "POST",
        body: JSON.stringify({ ...input, ...(options.trigger && { trigger: options.trigger }) }),
      });
      if (!response)
        throw new AppError("Openship Cloud is unreachable", 503, CLOUD_UNREACHABLE_CODE);
      const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
      if (!response.ok) {
        throw new AppError(
          typeof body?.error === "string"
            ? body.error
            : `Cloud deployment failed (${response.status})`,
          response.status,
          typeof body?.code === "string" ? body.code : undefined,
        );
      }
      const data = body?.data;
      if (!isCreateDeploymentResult(data)) {
        throw new AppError("Invalid cloud deployment response", 502, "INVALID_CLOUD_RESPONSE");
      }
      return data;
    },
    recordAudit(ctx, event) {
      audit.recordAsync(
        {
          organizationId: ctx.organizationId,
          actorUserId: ctx.userId,
          ipAddress: ctx.clientIp,
          userAgent: ctx.userAgent,
          source: ctx.source ?? "api",
          sourceClientId: ctx.sourceClientId,
        },
        event,
      );
    },
  }));
}
