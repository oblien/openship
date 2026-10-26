import { createHash } from "node:crypto";
import {
  AppError,
  ValidationError,
  SECURITY_FEED_SOURCE,
  isMutableImageRef,
  matchSecurityAdvisories,
  matchAdvisories,
  securityImageIdentity,
  satisfiesRange,
  type SecurityMatch,
} from "@repo/core";
import type { ApplySecurityInput, ProjectSecurityResult } from "@repo/contracts";
import { repos, db } from "@repo/db";
import type { ExecutionContext } from "../../../context";
import { assertNotControlPlane, assertResourceInOrg } from "../../lib/resource-access";
import { withProjectStateLock } from "../../lib/project-runtime-lock";
import { authorization } from "../../lib/authorization";
import { buildBackgroundContext } from "../../lib/background-context";
import { resolveOrgOwner } from "../../lib/org-actor";
import { audit, operationAuditContext } from "../../lib/audit-emitter";
import { notification } from "../../lib/notification-dispatcher";
import { resolveLatestImageDigest } from "../../lib/image-registry";
import { APP_VERSION } from "../../lib/app-version";
import { env } from "../../config/env";
import { reportCaughtError } from "@repo/core/diagnostics";
import { getAdvisoryFeed, type AdvisoryFeedState } from "./advisory-feed";
import { projectSecurityInventory } from "./security-inventory";
import { updateProjectRuntime } from "./runtime-update";
import { buildProjectSecurityResult } from "./security-status";
import { approveSecurityUpdate } from "./security-refresh-guard";
import { annotateSecurityRefreshAvailability } from "./security-refresh-availability";

const key = (...parts: (string | number | null)[]) =>
  createHash("sha256").update(JSON.stringify(parts)).digest("hex");
let organizationCursor: string | undefined;

/** Platform alerts also reach workspaces without deployments. Delivery is durable and deduplicated. */
async function notifyPlatformAdvisories(feed: AdvisoryFeedState) {
  // Cloud operators own the control plane. Tenant app advisories are handled
  // separately below; operational Cloud notices use the existing notices flow.
  if (env.CLOUD_MODE) return;
  const mode = env.DEPLOY_MODE === "desktop" ? "desktop" : "selfhosted";
  const notices = [
    ...(feed.security?.advisories ?? [])
      .filter((item) =>
        item.targets.some(
          (target) => target.kind === "platform" && satisfiesRange(APP_VERSION, target.affected),
        ),
      )
      .map((item) => ({
        key: `security-platform:${item.id}:${item.revision}`,
        title: item.title,
        message: item.message,
        url: item.url,
      })),
    ...matchAdvisories(APP_VERSION, feed.release.manifest ?? { advisories: [] }, mode)
      .filter((item) => item.announce && item.severity === "critical")
      .map((item) => ({
        key: `security-release:${item.id}`,
        title: item.title,
        message: item.message,
        url: item.action?.url,
      })),
  ];
  if (!notices.length) return;
  const organizations = await repos.securityAdvisory.organizationsForScan(organizationCursor);
  for (const org of organizations) {
    for (const item of notices) {
      const save = await notification.prepare({
        organizationId: org.id,
        resourceType: "updates",
        eventType: "security.advisory",
        idempotencyKey: item.key,
        payload: {
          message: `${item.title}\n${item.message}\nOpen Settings → Updates to review the available release.`,
          url: item.url,
          durable: true,
        },
      });
      await db.transaction(save);
    }
    organizationCursor = org.id;
  }
  if (organizations.length < 100) organizationCursor = undefined;
}

export async function projectSecurityStatus(
  ctx: ExecutionContext,
  projectId: string,
  feed?: AdvisoryFeedState,
  refresh = false,
): Promise<ProjectSecurityResult> {
  const project = await repos.project.findById(projectId);
  assertResourceInOrg(project, "Project", ctx.organizationId, projectId);
  const upstream = feed ?? (await getAdvisoryFeed(ctx));
  const state = await repos.securityAdvisory.project(projectId);
  const inventory = await projectSecurityInventory(
    ctx,
    projectId,
    upstream.security?.advisories ?? [],
    refresh,
  );
  const result = buildProjectSecurityResult(
    projectId,
    inventory,
    upstream,
    state?.autoRefresh ?? false,
    new Map(
      (await repos.service.listByProject(projectId)).map((service) => [service.id, service.name]),
    ),
  );
  await annotateSecurityRefreshAvailability(ctx, result);
  return result;
}

export async function setProjectSecurityPolicy(
  ctx: ExecutionContext,
  projectId: string,
  input: { autoRefresh: boolean },
) {
  return withProjectStateLock(projectId, async () => {
    const project = await repos.project.findById(projectId);
    assertResourceInOrg(project, "Project", ctx.organizationId, projectId);
    assertNotControlPlane(project);
    const state = await repos.securityAdvisory.policy(
      projectId,
      ctx.organizationId,
      ctx.userId,
      input.autoRefresh,
    );
    audit.recordAsync(operationAuditContext(ctx), {
      eventType: "project:write",
      resourceType: "project",
      resourceId: projectId,
      after: { operation: "securityPolicy", autoRefresh: state.autoRefresh },
    });
    return { autoRefresh: state.autoRefresh };
  });
}

/** The registry must still advertise a signed fixed digest on the user's existing tag. */
async function verifiedReplacement(match: SecurityMatch): Promise<string | null> {
  if (
    match.confidence !== "confirmed" ||
    !match.serviceId ||
    !match.image ||
    match.image.role !== "image" ||
    !isMutableImageRef(match.image.ref)
  )
    return null;
  const identity = securityImageIdentity(match.image.ref);
  if (!identity) return null;
  const target = match.advisory.targets.find(
    (item) =>
      item.kind === "image" &&
      securityImageIdentity(item.repository)?.repository === identity.repository &&
      !!match.image?.digest &&
      item.affectedDigests.includes(match.image.digest),
  );
  if (!target || target.kind !== "image" || !target.fixedDigests.length) return null;
  const latest = await resolveLatestImageDigest(match.image.ref, { refresh: true });
  return latest && target.fixedDigests.includes(latest) ? `${identity.repository}@${latest}` : null;
}

export async function applySecurityAdvisory(
  ctx: ExecutionContext,
  projectId: string,
  input: ApplySecurityInput,
  automatic = false,
) {
  const feed = await getAdvisoryFeed(ctx);
  if (feed.stale || !feed.security)
    throw new ValidationError(
      "A current, verified advisory feed is required. Retry the check before updating.",
    );
  return withProjectStateLock(projectId, async () => {
    const project = await repos.project.findById(projectId);
    assertResourceInOrg(project, "Project", ctx.organizationId, projectId);
    assertNotControlPlane(project);
    if (
      !(await authorization.checkPermissionOnResource(ctx, {
        resourceType: "project",
        resourceId: projectId,
        action: "write",
      }))
    )
      throw new AppError("Project write access is required.", 403);
    if (project.activeDeploymentId !== input.deploymentId)
      throw new ValidationError("The active deployment changed. Check the advisory again.");
    if (automatic) {
      const policy = await repos.securityAdvisory.project(projectId);
      if (!policy?.autoRefresh || policy.approvedBy !== ctx.userId)
        throw new ValidationError("Automatic security refresh is not enabled by this account.");
    }
    const inventory = await projectSecurityInventory(
      ctx,
      projectId,
      feed.security!.advisories,
      true,
    );
    const matches = matchSecurityAdvisories(
      feed.security!,
      inventory.images,
      inventory.runtimes,
    ).filter(
      (match) =>
        match.advisory.id === input.advisoryId && match.serviceId === (input.serviceId ?? null),
    );
    const match = matches.find((item) => item.image?.role === "image") ?? matches[0];
    if (!match || match.advisory.action !== "refresh-images")
      throw new ValidationError(
        "This advisory has no applicable runtime refresh. Review its guidance.",
      );
    let verified:
      | { deploymentId: string; images: Record<string, string>; expiresAt: string }
      | undefined;
    if (automatic) {
      const replacement = await verifiedReplacement(match);
      if (!replacement || !match.serviceId) return null;
      verified = {
        deploymentId: input.deploymentId,
        images: { [match.serviceId]: replacement },
        expiresAt: feed.security!.expiresAt,
      };
    }
    const attempt = key(
      projectId,
      input.advisoryId,
      match.advisory.revision,
      input.serviceId ?? null,
      input.deploymentId,
    );
    if (
      automatic &&
      !(await repos.securityAdvisory.claimAttempt(attempt, projectId, {
        advisoryId: input.advisoryId,
        serviceId: match.serviceId!,
        image: verified!.images[match.serviceId!]!,
      }))
    )
      return null;
    try {
      const result = await updateProjectRuntime(
        ctx,
        projectId,
        input.serviceId ? { serviceIds: [input.serviceId] } : {},
        verified && match.serviceId
          ? await approveSecurityUpdate(project, {
              deploymentId: verified.deploymentId,
              approvedBy: ctx.userId,
              expiresAt: verified.expiresAt,
              serviceId: match.serviceId,
              image: verified.images[match.serviceId]!,
            })
          : undefined,
      );
      if (automatic)
        await repos.securityAdvisory.finishAttempt(attempt, {
          status: result.awaiting_actions ? "awaiting_actions" : "queued",
          deploymentId: result.deployment_id,
          actionRequestId: result.action_request_id,
        });
      audit.recordAsync(operationAuditContext(ctx), {
        eventType: "project:write",
        resourceType: "project",
        resourceId: projectId,
        after: {
          operation: "securityRefresh",
          advisoryId: input.advisoryId,
          automatic,
          deploymentId: result.deployment_id,
        },
      });
      return result;
    } catch (error) {
      if (automatic) {
        await repos.securityAdvisory.finishAttempt(attempt, {
          status: "failed",
          error: "Automatic refresh needs review. Open the service to retry manually.",
        });
        await notification.emitSync({
          organizationId: ctx.organizationId,
          resourceType: "project",
          resourceId: projectId,
          eventType: "security.refresh_failed",
          idempotencyKey: `security-failed:${attempt}`,
          payload: {
            projectName: project.name,
            message: `Automatic refresh for ${match.advisory.title} could not start. Review the service and retry manually.`,
            url: match.advisory.url,
          },
        });
      }
      throw error;
    }
  });
}

/** Scheduler-owned, bounded sweep. Durable notification keys survive retries and restarts. */
export async function scanSecurityAdvisories() {
  await reconcileSecurityRefreshes();
  const first = (await repos.project.listAllForScan(1))[0];
  const owner = first ? await resolveOrgOwner(first.organizationId) : null;
  const pollingContext =
    owner && first
      ? buildBackgroundContext({
          userId: owner.userId,
          organizationId: first.organizationId,
          label: "security:poll",
        })
      : undefined;
  const feed = await getAdvisoryFeed(pollingContext);
  await notifyPlatformAdvisories(feed);
  if (!feed.security) return { checked: 0, notices: 0, stale: true };
  const projects = await repos.securityAdvisory.candidates(feed.security.revision);
  const deadline = Date.now() + 120_000;
  let checked = 0,
    notices = 0;
  for (const project of projects) {
    if (Date.now() >= deadline) break;
    try {
      const actor = await resolveOrgOwner(project.organizationId);
      if (!actor) continue;
      const ctx = buildBackgroundContext({
        userId: actor.userId,
        organizationId: project.organizationId,
        label: "security:scan",
      });
      const status = await projectSecurityStatus(ctx, project.id, feed);
      for (const finding of status.findings) {
        const save = await notification.prepare({
          organizationId: project.organizationId,
          resourceType: "project",
          resourceId: project.id,
          eventType: "security.advisory",
          idempotencyKey: `security:${key(project.id, finding.id, finding.revision, finding.serviceId)}`,
          payload: {
            projectName: project.name,
            message: `${finding.title}\n${finding.message}\nDetected: ${finding.evidence.join(", ")}\n${finding.canRefresh ? "Open the security banner in Openship and choose Review affected apps to inspect and refresh runtime images." : "Review the advisory and update the service configuration."}`,
            serviceName: finding.serviceName,
            url: finding.url,
            advisoryId: finding.id,
            durable: true,
          },
        });
        await db.transaction(save);
        notices++;
      }
      const policy = await repos.securityAdvisory.project(project.id);
      if (!feed.stale && policy?.autoRefresh && policy.approvedBy && status.deploymentId) {
        const approver = buildBackgroundContext({
          userId: policy.approvedBy,
          organizationId: project.organizationId,
          role: "restricted",
          label: "security:auto-refresh",
        });
        for (const finding of status.findings.filter((item) => item.canRefresh)) {
          const applied = await applySecurityAdvisory(
            approver,
            project.id,
            {
              advisoryId: finding.id,
              deploymentId: status.deploymentId,
              serviceId: finding.serviceId,
            },
            true,
          ).catch((error) => {
            reportCaughtError(error, "security-advisories.auto-refresh");
            return null;
          });
          if (applied) break;
        }
      }
      await repos.securityAdvisory.evaluated(
        project.id,
        project.organizationId,
        feed.security.revision,
      );
      checked++;
    } catch (error) {
      reportCaughtError(error, "security-advisories.scan");
    }
  }
  return { checked, notices, stale: feed.stale, source: SECURITY_FEED_SOURCE };
}

/** Deployment success is not proof of a runtime patch: verify the promoted artifact. */
export async function reconcileSecurityRefreshes() {
  for (const attempt of await repos.securityAdvisory.pendingAttempts()) {
    const project = await repos.project.findById(attempt.projectId);
    if (!project) continue;
    const deployment = attempt.deploymentId
      ? await repos.deployment.findById(attempt.deploymentId)
      : attempt.actionRequestId
        ? await repos.actions.deploymentForActionRequest(
            project.organizationId,
            attempt.actionRequestId,
          )
        : null;
    if (
      deployment &&
      (deployment.projectId !== project.id || deployment.organizationId !== project.organizationId)
    ) {
      await repos.securityAdvisory.finishAttempt(attempt.id, {
        status: "failed",
        error: "Deployment ownership changed.",
      });
      continue;
    }
    if (
      attempt.actionRequestId &&
      !deployment &&
      attempt.createdAt.getTime() > Date.now() - 86_400_000
    )
      continue;
    if (
      deployment &&
      (await repos.deployment.listInFlightByProject(project.id)).some(
        (row) => row.id === deployment.id,
      )
    )
      continue;
    if (
      deployment &&
      ![
        "ready",
        "failed",
        "cancelled",
        "partial_failure",
        "action_required",
        "rejected",
        "no_changes",
      ].includes(deployment.status)
    )
      continue;
    if (deployment?.status === "ready" && project.activeDeploymentId !== deployment.id) {
      await repos.securityAdvisory.finishAttempt(attempt.id, { status: "superseded" });
      continue;
    }
    const rows =
      deployment?.status === "ready" ? await repos.service.listByDeployment(deployment.id) : [];
    const verified = rows.some(
      (row) =>
        row.serviceId === attempt.serviceId &&
        row.status === "success" &&
        row.imageRef === attempt.image,
    );
    const failed = !verified;
    const save = await notification.prepare({
      organizationId: project.organizationId,
      resourceType: "project",
      resourceId: project.id,
      eventType: failed ? "security.refresh_failed" : "security.advisory",
      idempotencyKey: `security-result:${attempt.id}`,
      payload: {
        projectName: project.name,
        durable: true,
        advisoryId: attempt.advisoryId,
        message: failed
          ? "The automatic security refresh did not produce a verified active image. Open Deployments to review the result and retry manually."
          : "The automatic security refresh completed. The active service uses the replacement image identified in the signed advisory. Other runtime notices may still require review.",
      },
    });
    await db.transaction(save);
    await repos.securityAdvisory.finishAttempt(attempt.id, {
      status: verified ? "verified" : "failed",
    });
  }
}
