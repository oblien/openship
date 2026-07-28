/**
 * GitHub webhook push events — branch-matched redeployment.
 */

import { repos, type Project } from "@repo/db";
import { env } from "../../config/env";
import { triggerDeployment } from "../deployments/build.service";
import {
  compareCommits,
  getRepository,
} from "./github.service";
import { cloudFetchAsOrgOwner } from "../../lib/cloud/transport";
import { fetchOrgCloudProjects } from "../../lib/cloud/projects";
import { safeErrorMessage } from "@repo/core";
import {
  extractChangedFiles,
  routeServicesByChanges,
} from "./webhook-changed-files";
import { webhookActorCtx } from "./webhook-shared";
import { resolveOrgOwner } from "../../lib/org-actor";
import { notification } from "../../lib/notification-dispatcher";
import type { WebhookHandlerResult } from "../webhooks/webhook.types";
import type { GitHubPushPayload } from "./github.types";

// ─── Branch deployment events ────────────────────────────────────────────────

/** Surface a webhook auto-deploy that failed before a deployment row existed
 *  (so the pipeline's own deployment.failed never fired). Org-scoped +
 *  fire-and-forget — reaches members/channels even when there's no owner. */
function notifyAutoDeployFailed(project: Project, err: unknown): void {
  notification.emit({
    organizationId: project.organizationId,
    eventType: "deployment.failed",
    resourceType: "project",
    resourceId: project.id,
    payload: {
      projectName: project.name,
      trigger: "webhook",
      reason: safeErrorMessage(err),
    },
  });
}

/** Best-effort webhook_delivery feed row for a GitHub push outcome. Never throws
 *  (observability must not break the deploy). `p` null = a forwarded/unmanaged row. */
function recordPushDelivery(
  p: Project | null,
  input: BranchDeploymentTrigger,
  outcome: string,
  opts?: { organizationId?: string | null; actionRef?: string | null; error?: string | null },
): void {
  void repos.webhookDelivery
    .record({
      organizationId: p?.organizationId ?? opts?.organizationId ?? undefined,
      projectId: p?.id ?? undefined,
      source: "github",
      event: input.event,
      authResult: "ok",
      outcome,
      actionRef: opts?.actionRef ?? undefined,
      error: opts?.error ?? undefined,
      summary: {
        repo: `${input.owner}/${input.repo}`,
        branch: input.branch,
        commit: input.commitSha ?? undefined,
      },
    })
    .catch(() => {});
}

export async function handlePush(payload: GitHubPushPayload): Promise<WebhookHandlerResult> {
  const owner = payload.repository?.owner?.login;
  const repo = payload.repository?.name;
  const ref = payload.ref;
  const commitSha = payload.head_commit?.id;
  const defaultBranch = payload.repository?.default_branch;

  if (!owner || !repo) {
    return { success: false, event: "push", error: "Missing repository info in payload" };
  }

  if (payload.deleted) {
    return { success: true, event: "push", message: "Ignoring deleted branch push" };
  }

  if (!ref?.startsWith("refs/heads/")) {
    return { success: true, event: "push", message: `Ignoring non-branch ref: ${ref ?? "unknown"}` };
  }

  const branch = ref.replace("refs/heads/", "");

  return triggerBranchDeployments({
    event: "push",
    owner,
    repo,
    branch,
    defaultBranch,
    commitSha,
    commitMessage: payload.head_commit?.message,
    payload,
  });
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

interface BranchDeploymentTrigger {
  event: "push";
  owner: string;
  repo: string;
  branch: string;
  defaultBranch?: string | null;
  commitSha?: string;
  commitMessage?: string;
  /** Raw push payload — needed for smart per-service routing. */
  payload?: GitHubPushPayload;
}

async function deployProjectFromPush(
  p: Project,
  input: BranchDeploymentTrigger,
) {
  // Webhooks have no human actor — attribute to the org OWNER (owns the
  // GitHub App installation + is the meaningful audit actor). No owner =
  // broken org state; fail rather than guess a random member.
  const owner = await resolveOrgOwner(p.organizationId).catch(() => null);
  if (!owner) {
    throw new Error(
      `No org owner available to act as webhook actor for project ${p.id} (org ${p.organizationId})`,
    );
  }
  const actorUserId = owner.userId;

  // ── Smart per-service routing ────────────────────────────────
  // Load services so we can answer "what changed in this push,
  // and which services does it affect?". For force-deploy paths
  // (forceAll / forceDeployNext / single-service projects with
  // no affected services) we just deploy everything.
  const services = await repos.service.listByProject(p.id).catch(() => []);
  const enabledServices = services.filter((s) => s.enabled);

  // Treat compose- and monorepo-kind services as "real" routable
  // services. A project with zero such rows is a single-app
  // project and always rebuilds (no smart routing to do).
  const routableServices = enabledServices.filter(
    (s) => s.kind === "compose" || s.kind === "monorepo",
  );

  let serviceIds: string[] | undefined;
  let forceAll = false;
  let routingReason: string | undefined;
  let changedPathsTruncated = false;
  let changedPaths: string[] | undefined;

  if (input.payload) {
    const extracted = await extractChangedFiles(input.payload, {
      isMonorepo:
        p.framework === "monorepo" || routableServices.length > 0,
      monorepoSharedPaths: p.monorepoSharedPaths,
      compareCommits: async (owner, repo, base, head) =>
        compareCommits(
          webhookActorCtx(actorUserId, p.organizationId ?? "", "webhook:compare-commits"),
          owner,
          repo,
          base,
          head,
        ),
    });

    forceAll = extracted.forceAll;
    routingReason = extracted.reason;
    changedPathsTruncated = extracted.truncated ?? false;
    changedPaths = Array.from(extracted.files);
    if (changedPathsTruncated) {
      // Full changed set unknown → deploy everything; under-deploy would ship stale code.
      forceAll = true;
      routingReason = routingReason ?? "changed-files-truncated";
      console.warn(
        `[GitHub Webhook] ${input.owner}/${input.repo}#${input.branch} project ${p.id}: changed-files set is truncated (commits[] >= 20 and compareCommits could not recover the full list) — deploying all services (forceAll).`,
      );
    }

    // Honor the project-level one-shot "rebuild everything next
    // time" flag and clear it in the same tick. Atomic compare-and-set
    // so two concurrent webhooks can't both observe `true` and
    // double-fire force.
    const consumed = await repos.project
      .consumeForceDeployNext(p.id)
      .catch(() => false);
    if (consumed) {
      forceAll = true;
      routingReason = routingReason ?? "force-deploy-next";
    }

    if (!forceAll && routableServices.length > 0) {
      const routed = routeServicesByChanges(routableServices, extracted.files);
      if (routed.mode === "skip") {
        // No services affected → skip the deploy entirely. (mode "all" can't
        // occur here since routableServices.length > 0.)
        console.log(
          `[GitHub Webhook] ${input.owner}/${input.repo}#${input.branch} project ${p.id}: no services affected by ${extracted.files.size} changed file(s) — skipping deploy.`,
        );
        return { skipped: true as const, projectId: p.id };
      }
      if (routed.mode === "services") {
        serviceIds = routed.serviceIds;
      }
    }
  } else {
    // No payload was passed (manual trigger path going through this
    // code). Atomically consume the flag — same compare-and-set as
    // the payload branch — so concurrent manual triggers can't both
    // observe it `true`.
    const consumed = await repos.project
      .consumeForceDeployNext(p.id)
      .catch(() => false);
    if (consumed) {
      forceAll = true;
      routingReason = "force-deploy-next";
    }
  }

  if (routingReason) {
    console.log(
      `[GitHub Webhook] ${input.owner}/${input.repo}#${input.branch} project ${p.id}: forceAll=true (${routingReason})`,
    );
  }

  // Rollback context (strategy + commit_sha_before anchor) is resolved inside
  // triggerDeployment via the shared resolveRollbackContext helper — no need to
  // recompute it here.
  const triggered = await triggerDeployment(
    webhookActorCtx(actorUserId, p.organizationId, "webhook:github-push"),
    {
      projectId: p.id,
      branch: input.branch,
      commitSha: input.commitSha,
      commitMessage: input.commitMessage,
      trigger: "webhook",
      serviceIds,
      forceAll,
      // Let the compose-drift reconciler skip its repo scan when this push
      // didn't touch a compose file. Truncated → pass null (unknown → reconcile).
      changedPaths: changedPathsTruncated ? null : changedPaths,
    },
  );

  // Persist changed-files onto the deployment row for the dashboard. Best-effort.
  // Skip when deduped — `triggered.deployment` is the already-live one, not ours.
  if (!triggered?.skipped && triggered?.deployment?.id && (changedPaths || changedPathsTruncated)) {
    const deploymentId = triggered.deployment.id;
    await repos.deployment
      .setChangedPaths(
        deploymentId,
        changedPaths && changedPaths.length > 0 ? changedPaths : null,
        changedPathsTruncated,
      )
      .catch((err: unknown) => {
        console.warn(
          `[GitHub Webhook] failed to persist changedPaths for ${deploymentId}:`,
          err,
        );
      });
  }

  return triggered;
}

async function triggerBranchDeployments(
  input: BranchDeploymentTrigger,
): Promise<WebhookHandlerResult> {
  // Dedup lives upstream now (delivery-id claim + commit-sha guard) — no Set here.
  const projects = await repos.project.findByGitRepo(input.owner, input.repo);
  const defaultBranch = await resolveDefaultBranch(input, projects);
  const branchProjects = projects.filter(
    (p) => p.autoDeploy && projectWebhookBranch(p, defaultBranch) === input.branch,
  );

  // Tenant binding (multi-tenant safety): a GitHub App push is signed with the
  // single App secret — identical for every org — so the signature proves the
  // push came from GitHub, NOT which tenant it belongs to. findByGitRepo matches
  // by repo STRING alone, so without this a tenant who created a project
  // pointing at another org's repo would be fanned into that org's pushes and
  // receive the repo's commit metadata (and trigger unauthorized deploys). Bind
  // the fan-out to the DELIVERING installation: only projects whose
  // installationId matches the delivery's installation.id deploy. createProject
  // resolves installationId from the caller's own org, so a squatter's project
  // can never carry the victim's installation id. Repo-webhook / PAT deliveries
  // carry no installation id (an App-only payload field) and are already scoped
  // by their per-project secret → left unfiltered.
  const deliveredInstallationId = input.payload?.installation?.id ?? null;
  const autoDeployProjects =
    deliveredInstallationId != null
      ? branchProjects.filter((p) => p.installationId === deliveredInstallationId)
      : branchProjects;
  const droppedForInstallation = branchProjects.length - autoDeployProjects.length;
  if (droppedForInstallation > 0) {
    console.warn(
      `[GitHub Webhook] ${input.event} ${input.owner}/${input.repo}#${input.branch}: skipped ` +
        `${droppedForInstallation} branch-matched project(s) not bound to delivering installation ` +
        `${deliveredInstallationId} (cross-tenant fan-out guard)`,
    );
  }

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
          `[GitHub Webhook] ${input.event} for ${input.owner}/${input.repo}#${input.branch} - forwarded to Openship Cloud (${fwd.cloudProjectId})`,
        );
        recordPushDelivery(null, input, "forwarded", {
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
      `[GitHub Webhook] ${input.event} for ${input.owner}/${input.repo}#${input.branch} - no matching LOCAL auto-deploy project (cloud projects deploy via the SaaS)`,
    );
    recordPushDelivery(null, input, "ignored");
    return { success: true, event: input.event, message: "No local auto-deploy projects matched" };
  }

  const results = await Promise.allSettled(
    autoDeployProjects.map((p) =>
      // A webhook has no interactive user watching for errors. When a redeploy
      // is blocked BEFORE a deployment row exists (preflight throws with no
      // clone credential, or the org has no owner), the pipeline's own
      // deployment.failed never fires — emit it here so auto-deploy doesn't
      // silently go dark. Rethrow to preserve the failed count + log below.
      deployProjectFromPush(p, input).catch((err) => {
        notifyAutoDeployFailed(p, err);
        throw err;
      }),
    ),
  );

  let succeeded = 0;
  let skipped = 0;
  let failed = 0;
  results.forEach((r, i) => {
    const p = autoDeployProjects[i];
    if (r.status === "fulfilled") {
      const v = r.value as { deployment?: { id?: string }; skipped?: boolean } | undefined;
      if (v?.skipped) {
        skipped++;
        recordPushDelivery(p, input, "skipped");
      } else {
        succeeded++;
        recordPushDelivery(p, input, "dispatched", { actionRef: v?.deployment?.id });
      }
    } else {
      failed++;
      recordPushDelivery(p, input, "failed", { error: String(r.reason) });
    }
  });

  if (failed > 0) {
    const errors = results
      .filter((r): r is PromiseRejectedResult => r.status === "rejected")
      .map((r) => String(r.reason));
    console.error(
      `[GitHub Webhook] ${input.event} deploy failures for ${input.owner}/${input.repo}#${input.branch}:`,
      errors,
    );
  }

  return {
    success: true,
    event: input.event,
    message:
      `Triggered ${succeeded} deployment(s) for ${input.owner}/${input.repo}#${input.branch}` +
      `${skipped ? `, ${skipped} skipped (no affected services)` : ""}` +
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
    .findByRepo(input.owner, input.repo)
    .catch(() => []);
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
    const orgIds = await repos.settings.listCloudLinkedOrgIds().catch(() => []);
    const ownerKey = input.owner.toLowerCase();
    const repoKey = input.repo.toLowerCase();
    for (const orgId of orgIds) {
      const result = await fetchOrgCloudProjects(orgId).catch(() => null);
      if (result?.state !== "merged") continue;
      const match = result.projects.find((p) => {
        const o = typeof p.gitOwner === "string" ? p.gitOwner.toLowerCase() : "";
        const r = typeof p.gitRepo === "string" ? p.gitRepo.toLowerCase() : "";
        if (o !== ownerKey || r !== repoKey || p.autoDeploy !== true) return false;
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
            gitOwner: input.owner,
            gitRepo: input.repo,
            gitBranch: typeof match.gitBranch === "string" ? match.gitBranch : "",
            webhookId: null,
            webhookSecret: null,
          })
          .catch(() => {});
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
  }).catch(() => null);

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
    const owner = await resolveOrgOwner(unbranchedProject.organizationId).catch(() => null);
    if (!owner) return null;
    const repository = await getRepository(
      webhookActorCtx(owner.userId, unbranchedProject.organizationId, "webhook:github-resolve-default-branch"),
      input.owner,
      input.repo,
    );
    return repository.default_branch;
  } catch (err) {
    const message = safeErrorMessage(err);
    console.warn(
      `[GitHub Webhook] Could not resolve default branch for ${input.owner}/${input.repo}: ${message}`,
    );
    return null;
  }
}
