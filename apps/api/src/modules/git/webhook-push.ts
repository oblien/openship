/**
 * Dispatch a verified provider push through normal branch and service deployment admission.
 */

import { observedAllSettled, reportCaughtError as observeCaughtError, diagnostics as errorDiagnostics } from "@repo/core/diagnostics";
import { repos, type Project } from "@repo/db";
import { env } from "@repo/platform/engine/config/env";
import { triggerDeployment } from "@repo/platform/engine/modules/deployments/build.service";
import { gitRepository } from "@repo/platform/engine/modules/git/provider";
import type { GitRepository } from "@repo/platform/engine/modules/git/types";
import { cloudFetchAsOrgOwner } from "@repo/platform/engine/lib/cloud/transport";
import { fetchOrgCloudProjects } from "@repo/platform/engine/lib/cloud/projects";
import { type GitRepositoryRef, matchesProjectRepository, safeErrorMessage } from "@repo/core";
import { routeServicesByChanges, type ChangedFilesResult } from "@repo/platform/engine/modules/git/changed-files";
import { resolveProjectChangeImpact } from "@repo/platform/engine/modules/git/project-change-impact";
import { webhookActorCtx } from "./webhook-shared";
import { resolveOrgOwner } from "@repo/platform/engine/lib/org-actor";
import { notifyAutoDeployFailed } from "@repo/platform/engine/modules/git/queued-pushes";
import type { WebhookHandlerResult } from "@repo/platform/engine/modules/webhooks/webhook.types";

// ─── Branch deployment events ────────────────────────────────────────────────

/** Best-effort webhook_delivery feed row for a provider push outcome. Never throws
 *  (observability must not break the deploy). `p` null = a forwarded/unmanaged row. */
function recordPushDelivery(
  p: Project | null,
  input: BranchDeploymentTrigger,
  outcome: string,
  opts?: { organizationId?: string | null; actionRef?: string | null; error?: string | null; reason?: string },
): Promise<void> {
  return repos.webhookDelivery
    .record({
      organizationId: p?.organizationId ?? opts?.organizationId ?? undefined,
      projectId: p?.id ?? undefined,
      source: input.repository.provider,
      event: input.event,
      authResult: "ok",
      outcome,
      actionRef: opts?.actionRef ?? undefined,
      error: opts?.error ?? undefined,
      summary: {
        repo: `${input.repository.namespace}/${input.repository.name}`,
        branch: input.branch,
        commit: input.commitSha ?? undefined,
        ...(opts?.reason ? { reason: opts.reason } : {}),
      },
    })
    .then(() => {})
    .catch((diagnosticFailure) => {
      observeCaughtError(diagnosticFailure, "api/modules/git/webhook-push");
    });
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

interface BranchDeploymentTrigger {
  event: "push";
  repository: GitRepositoryRef;
  branch: string;
  defaultBranch?: string | null;
  commitSha?: string;
  commitMessage?: string;
  organizationIds?: readonly string[];
  matchesProject?(project: Project): boolean;
  actionEvent: Record<string, unknown>;
  changes(repository: GitRepository, options: {
    isMonorepo: boolean; monorepoSharedPaths: string[] | null;
  }): Promise<ChangedFilesResult>;
}

async function deployProjectFromPush(
  p: Project,
  input: BranchDeploymentTrigger,
) {
  // Webhooks have no human actor — attribute to the org OWNER (owns the
  // GitHub App installation + is the meaningful audit actor). No owner =
  // broken org state; fail rather than guess a random member.
  const owner = await resolveOrgOwner(p.organizationId).catch((diagnosticFailure) => { observeCaughtError(diagnosticFailure, "api/modules/git/webhook-push"); return null; });
  if (!owner) {
    throw new Error(
      `No org owner available to act as webhook actor for project ${p.id} (org ${p.organizationId})`,
    );
  }
  const actor = webhookActorCtx(owner.userId, p.organizationId, "webhook:push");

  // ── Smart per-service routing ────────────────────────────────
  // Load services so we can answer "what changed in this push,
  // and which services does it affect?". For force-deploy paths
  // (forceAll / forceDeployNext / single-service projects with
  // no affected services) we just deploy everything.
  const services = await repos.service.listByProject(p.id).catch((diagnosticFailure) => { observeCaughtError(diagnosticFailure, "api/modules/git/webhook-push"); return []; });
  const enabledServices = services.filter((s) => s.enabled);

  // Treat compose- and monorepo-kind services as "real" routable
  // services. Single-app projects use the shared path policy below.
  const routableServices = enabledServices.filter(
    (s) => s.kind === "compose" || s.kind === "monorepo",
  );

  let serviceIds: string[] | undefined;
  let changeReason: string | undefined;

  const repository = gitRepository(actor, input.repository);
  const extracted = await input.changes(repository, {
    isMonorepo: p.framework === "monorepo" || routableServices.length > 0,
    monorepoSharedPaths: p.monorepoSharedPaths,
  });

  let forceAll = extracted.forceAll;
  let routingReason = extracted.reason;
  const changedPathsTruncated = extracted.truncated ?? false;
  const changedPaths = Array.from(extracted.files);
  if (changedPathsTruncated) {
    // Full changed set unknown → deploy everything; under-deploy would ship stale code.
    forceAll = true;
    routingReason = routingReason ?? "changed-files-truncated";
    errorDiagnostics.warn("api/modules/git/webhook-push",
      `[Git Webhook] ${input.repository.namespace}/${input.repository.name}#${input.branch} project ${p.id}: changed-files set is truncated — deploying all services (forceAll).`,
    );
  }

  // Honor the project-level one-shot "rebuild everything next
  // time" flag and clear it in the same tick. Atomic compare-and-set
  // so two concurrent webhooks can't both observe `true` and
  // double-fire force.
  const consumed = await repos.project
    .consumeForceDeployNext(p.id)
    .catch((diagnosticFailure) => { observeCaughtError(diagnosticFailure, "api/modules/git/webhook-push"); return false; });
  if (consumed) {
    forceAll = true;
    routingReason = routingReason ?? "force-deploy-next";
  }

  if (!forceAll) {
    // Compare with the deployed release, not just this push's before SHA: a
    // previous failed deployment may contain app changes still waiting to ship.
    const active = p.activeDeploymentId ? await repos.deployment.findById(p.activeDeploymentId) : null;
    const compare = active?.projectId === p.id && active.commitSha && input.commitSha
      ? await repository.compare(active.commitSha, input.commitSha)
          .catch(error => { observeCaughtError(error, "api/modules/git/webhook-push"); return null; })
      : null;
    const impact = compare && !compare.truncated
      ? await resolveProjectChangeImpact(actor, p, compare.files, input.commitSha)
      : { affected: true, reason: active ? "unknown-deployed-diff" : "first-deployment" };
    changeReason = impact.reason;
    console.log(`[Git Webhook] project ${p.id}: ${impact.affected ? "deploying" : "skipping"} (${impact.reason}).`);
    if (!impact.affected) return { skipped: true as const, projectId: p.id, reason: impact.reason };
  }

  if (!forceAll && routableServices.length > 0) {
    const routed = routeServicesByChanges(routableServices, extracted.files);
    if (routed.mode === "skip") {
      // No services affected → skip the deploy entirely. (mode "all" can't
      // occur here since routableServices.length > 0.)
      console.log(
        `[Git Webhook] ${input.repository.namespace}/${input.repository.name}#${input.branch} project ${p.id}: no services affected by ${extracted.files.size} changed file(s) — skipping deploy.`,
      );
      return { skipped: true as const, projectId: p.id };
    }
    if (routed.mode === "services") {
      serviceIds = routed.serviceIds;
    }
  }

  if (routingReason) {
    console.log(
      `[Git Webhook] ${input.repository.namespace}/${input.repository.name}#${input.branch} project ${p.id}: forceAll=true (${routingReason})`,
    );
  }

  changeReason ??= routingReason;

  // Rollback context (strategy + commit_sha_before anchor) is resolved inside
  // triggerDeployment via the shared resolveRollbackContext helper — no need to
  // recompute it here.
  const triggered = await triggerDeployment(
    actor,
    {
      projectId: p.id,
      branch: input.branch,
      commitSha: input.commitSha,
      commitMessage: input.commitMessage,
      trigger: "webhook",
      serviceIds,
      actionEvent: input.actionEvent,
      forceAll,
      // Let the compose-drift reconciler skip its repo scan when this push
      // didn't touch a compose file. Truncated → pass null (unknown → reconcile).
      changedPaths: changedPathsTruncated ? null : changedPaths,
    },
  );
  if ("queuedPush" in triggered) return { queued: true as const };


  // Persist changed-files onto the deployment row for the dashboard. Best-effort.
  // Skip when deduped — `triggered.deployment` is the already-live one, not ours.
  if (!triggered?.skipped && triggered?.deployment?.id) {
    const deploymentId = triggered.deployment.id;
    await repos.deployment
      .setChangedPaths(
        deploymentId,
        changedPaths.length > 0 ? changedPaths : null,
        changedPathsTruncated,
      )
      .catch((err: unknown) => {
        errorDiagnostics.warn("api/modules/git/webhook-push",
          `[Git Webhook] failed to persist changedPaths for ${deploymentId}:`,
          err,
        );
      });
  }

  return { ...triggered, ...(changeReason && !triggered?.skipped ? { reason: changeReason } : {}) };
}

export async function triggerBranchDeployments(
  input: BranchDeploymentTrigger,
  handledProjectIds: Set<string>,
): Promise<WebhookHandlerResult> {
  // Dedup lives upstream now (delivery-id claim + commit-sha guard) — no Set here.
  const projects = await repos.project.findByGitRepo(input.repository, input.organizationIds);
  const authorized = input.matchesProject ? projects.filter(input.matchesProject) : projects;
  const defaultBranch = await resolveDefaultBranch(input, authorized);
  const autoDeployProjects = authorized.filter(
    project => project.autoDeploy && projectWebhookBranch(project, defaultBranch) === input.branch,
  );

  if (autoDeployProjects.length === 0) {
    // No matching LOCAL project. It may be a CLOUD project whose webhook still
    // points at this self-hosted box (promote preserves it). Forward the push
    // to the SaaS as the org owner so the cloud copy redeploys — the same op
    // the Redeploy button proxies. On the SaaS itself (CLOUD_MODE) there is
    // nothing upstream to forward to.
    if (!env.CLOUD_MODE) {
      const fwd = await forwardPushToCloud(input, defaultBranch);
      if (fwd.forwarded) {
        console.log(
          `[Git Webhook] ${input.event} for ${input.repository.namespace}/${input.repository.name}#${input.branch} - forwarded to Openship Cloud (${fwd.cloudProjectId})`,
        );
        await recordPushDelivery(null, input, "forwarded", {
          organizationId: fwd.organizationId,
          actionRef: fwd.cloudProjectId,
        });
        return {
          success: true,
          event: input.event,
          message: `Forwarded push to Openship Cloud (${fwd.cloudProjectId})`,
        };
      }
    }
    console.log(
      `[Git Webhook] ${input.event} for ${input.repository.namespace}/${input.repository.name}#${input.branch} - no matching LOCAL auto-deploy project (cloud projects deploy via the SaaS)`,
    );
    await recordPushDelivery(null, input, "ignored");
    return { success: true, event: input.event, message: "No local auto-deploy projects matched" };
  }

  // A partial fan-out failure makes the delivery retryable. Keep successful
  // targets in its durable receipt: commit-based dedup cannot protect a target
  // that has since deployed a newer commit, or an event that forces all services.
  const pendingProjects = autoDeployProjects.filter((p) => !handledProjectIds.has(p.id));
  const alreadyHandled = autoDeployProjects.length - pendingProjects.length;
  const results = await observedAllSettled(
    pendingProjects.map((p) =>
      // A webhook has no interactive user watching for errors. When a redeploy
      // is blocked BEFORE a deployment row exists (preflight throws with no
      // clone credential, or the org has no owner), the pipeline's own
      // deployment.failed never fires — emit it here so auto-deploy doesn't
      // silently go dark. Rethrow to preserve the failed count + log below.
      deployProjectFromPush(p, input).catch((err) => {
        notifyAutoDeployFailed(p, err);
        throw err;
      }),
    ), "api/modules/git/webhook-push",
  );

  let succeeded = 0;
  let skipped = 0;
  let queued = 0;
  let failed = 0;
  await Promise.all(
    results.map(async (r, i) => {
      const p = pendingProjects[i];
      if (r.status === "fulfilled") {
        handledProjectIds.add(p.id);
        const v = r.value as
          | { deployment?: { id?: string }; skipped?: boolean; queued?: boolean; reason?: string }
          | undefined;
        if (v?.queued) {
          queued++;
        } else if (v?.skipped) {
          skipped++;
          await recordPushDelivery(p, input, "skipped", { reason: v.reason });
        } else {
          succeeded++;
          await recordPushDelivery(p, input, "dispatched", { actionRef: v?.deployment?.id, reason: v?.reason });
        }
      } else {
        failed++;
        await recordPushDelivery(p, input, "failed", { error: safeErrorMessage(r.reason) });
      }
    }),
  );

  if (failed > 0) {
    const errors = results
      .filter((r): r is PromiseRejectedResult => r.status === "rejected")
      .map((r) => String(r.reason));
    errorDiagnostics.error("api/modules/git/webhook-push",
      `[Git Webhook] ${input.event} deploy failures for ${input.repository.namespace}/${input.repository.name}#${input.branch}:`,
      errors,
    );
  }

  return {
    success: failed === 0,
    event: input.event,
    ...(failed
      ? {
          error: `${failed} deployment(s) could not be started. Review the project's webhook events and redeliver after resolving the failure.`,
        }
      : {}),
    message:
      `Triggered ${succeeded} deployment(s) for ${input.repository.namespace}/${input.repository.name}#${input.branch}` +
      `${alreadyHandled ? `, ${alreadyHandled} already handled by this delivery` : ""}` +
      `${skipped ? `, ${skipped} skipped (no relevant changes)` : ""}` +
      `${queued ? `, ${queued} queued behind a running deployment` : ""}` +
      `${failed ? `, ${failed} failed` : ""}`,
  };
}

/**
 * Forward a push for a CLOUD project (no local row) to the SaaS as the org
 * owner — the same operation the Redeploy button proxies. Resolution:
 *   1. cloud_webhook_binding by repo (fast, deterministic; written on promote).
 *   2. Fallback: enumerate cloud-linked orgs and match the repo against their
 *      cloud project list, then self-heal a routing-only binding for next time.
 * Returns { forwarded:false } when no cloud project owns this repo/branch.
 */
async function forwardPushToCloud(
  input: BranchDeploymentTrigger,
  defaultBranch?: string | null,
): Promise<{ forwarded: boolean; cloudProjectId?: string; organizationId?: string }> {
  let organizationId: string | undefined;
  let cloudProjectId: string | undefined;

  const bindings = await repos.cloudWebhookBinding
    .findByRepo(input.repository, input.organizationIds)
    .catch((diagnosticFailure) => { observeCaughtError(diagnosticFailure, "api/modules/git/webhook-push"); return []; });
  // Mirror projectWebhookBranch: "" means the repo's default branch, so resolve
  // it the same way the local filter does before comparing to the pushed branch.
  const bound = bindings.find(
    (b) => (b.gitBranch?.trim() || defaultBranch?.trim() || null) === input.branch,
  );
  if (bound) {
    organizationId = bound.organizationId;
    cloudProjectId = bound.cloudProjectId;
  }

  if (!cloudProjectId) {
    const orgIds = await repos.settings.listCloudLinkedOrgIds().catch((diagnosticFailure) => { observeCaughtError(diagnosticFailure, "api/modules/git/webhook-push"); return []; });
    for (const orgId of orgIds) {
      if (input.organizationIds && !input.organizationIds.includes(orgId)) continue;
      const result = await fetchOrgCloudProjects(orgId).catch((diagnosticFailure) => { observeCaughtError(diagnosticFailure, "api/modules/git/webhook-push"); return null; });
      if (result?.state !== "merged") continue;
      const match = result.projects.find((p) => {
        if (p.autoDeploy !== true || !matchesProjectRepository(p, input.repository)) return false;
        const b =
          (typeof p.gitBranch === "string" ? p.gitBranch.trim() : "") ||
          defaultBranch?.trim() ||
          "";
        return b === input.branch;
      });
      if (match && typeof match.id === "string") {
        organizationId = orgId;
        cloudProjectId = match.id;
        // Self-heal a routing-only binding (secret was lost on promote, so
        // validation stays on the env/legacy path) so the next push is fast.
        await repos.cloudWebhookBinding
          .upsert({
            organizationId: orgId,
            cloudProjectId: match.id,
            gitProvider: input.repository.provider,
            gitOwner: input.repository.namespace,
            gitRepo: input.repository.name,
            gitBranch: typeof match.gitBranch === "string" ? match.gitBranch : "",
            webhookId: null,
            webhookSecret: null,
          })
          .catch((diagnosticFailure) => {
            observeCaughtError(diagnosticFailure, "api/modules/git/webhook-push");
          });
        break;
      }
    }
  }

  if (!organizationId || !cloudProjectId) return { forwarded: false };

  const res = await cloudFetchAsOrgOwner(organizationId, "/api/deployments", {
    method: "POST",
    body: JSON.stringify({
      projectId: cloudProjectId,
      branch: input.branch,
      commitSha: input.commitSha,
      smartRoute: true,
      // Auto-deploy marker → SaaS applies commit-sha dedup (if the App also
      // delivered this push, whichever lands second skips).
      trigger: "webhook",
    }),
  }).catch((diagnosticFailure) => { observeCaughtError(diagnosticFailure, "api/modules/git/webhook-push"); return null; });

  return { forwarded: !!res && res.ok, cloudProjectId, organizationId };
}

function projectWebhookBranch(project: Project, defaultBranch?: string | null): string | null {
  return project.gitBranch?.trim() || defaultBranch?.trim() || null;
}

async function resolveDefaultBranch(
  input: BranchDeploymentTrigger,
  projects: Project[],
): Promise<string | null> {
  const payloadDefaultBranch = input.defaultBranch?.trim();
  if (payloadDefaultBranch) return payloadDefaultBranch;

  const unbranchedProject = projects.find(
    (p) => !p.gitBranch?.trim() && p.gitOwner && p.gitRepo,
  );
  if (!unbranchedProject) return null;

  try {
    const owner = await resolveOrgOwner(unbranchedProject.organizationId).catch((diagnosticFailure) => { observeCaughtError(diagnosticFailure, "api/modules/git/webhook-push"); return null; });
    if (!owner) return null;
    const repository = await gitRepository(
      webhookActorCtx(owner.userId, unbranchedProject.organizationId, "webhook:resolve-default-branch"),
      input.repository,
    ).info();
    return repository.default_branch;
  } catch (err) {
    const message = safeErrorMessage(err);
    errorDiagnostics.warn("api/modules/git/webhook-push",
      `[Git Webhook] Could not resolve default branch for ${input.repository.namespace}/${input.repository.name}: ${message}`, err,
    );
    return null;
  }
}
