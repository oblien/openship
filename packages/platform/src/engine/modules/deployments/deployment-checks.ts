import { createHash, randomUUID } from "node:crypto";
import { isServiceFailureStatus, isServiceSuccessStatus, safeErrorMessage } from "@repo/core";
import { diagnostics } from "@repo/core/diagnostics";
import { repos, type Deployment, type DeploymentCheck, type ServiceDeployment } from "@repo/db";
import { buildBackgroundContext } from "../../lib/background-context";
import { resolveOrgOwner } from "../../lib/org-actor";
import { runtimeTarget } from "../../config/index";
import { nativeJobsEnabled } from "../../native/execution-policy";
import { checkFailureSummary, syncGitHubCheck, type GitHubCheckUpdate } from "../github/check-runs";
import { rollupDeploymentStatus } from "./service-checks";

const TERMINAL = new Set(["ready", "failed", "partial_failure", "cancelled", "no_changes", "rejected", "action_required"]);
const RETRY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** Pure projection of persisted lifecycle state, shared by every deployment target. */
type CheckOutcome = Pick<GitHubCheckUpdate, "status" | "conclusion"> & { title: string };
export function deploymentCheckOutcome(dep: Pick<Deployment, "status">, workerActive: boolean): CheckOutcome {
  if (dep.status === "queued") return { status: "queued" as const, title: "Deployment queued" };
  if (workerActive && (dep.status === "cancelled" || dep.status === "rejected"))
    return { status: "in_progress", title: "Stopping deployment" };
  if (!TERMINAL.has(dep.status) || (dep.status === "ready" && workerActive))
    return { status: "in_progress" as const, title: dep.status === "building" ? "Building" : "Deploying" };
  const conclusion = dep.status === "ready" ? "success" : dep.status === "cancelled" || dep.status === "rejected" ? "cancelled"
    : dep.status === "no_changes" ? "neutral" : dep.status === "action_required" ? "action_required" : "failure";
  const title = dep.status === "ready" ? "Deployment succeeded" : dep.status === "no_changes" ? "No changes to deploy"
    : conclusion === "cancelled" ? "Deployment cancelled" : dep.status === "partial_failure" ? "Some services failed"
      : conclusion === "action_required" ? "Deployment needs attention" : "Deployment failed";
  return { status: "completed" as const, conclusion, title };
}

export function serviceCheckOutcome(
  row: Pick<ServiceDeployment, "status"> | undefined,
  targeted: boolean,
  parent: CheckOutcome,
): CheckOutcome {
  if (row?.status === "skipped" || (!targeted && !row))
    return { status: "completed" as const, conclusion: "neutral" as const, title: "Unchanged service" };
  if (row?.status === "cancelled")
    return { status: "completed" as const, conclusion: "cancelled" as const, title: "Service cancelled" };
  if (row && isServiceFailureStatus(row.status))
    return { status: "completed" as const, conclusion: "failure" as const, title: "Service failed" };
  // A started container is not a successful release while activation can still
  // fail. The rollup and services complete from the same durable outcome.
  if (parent.status !== "completed") return { status: parent.status, title: row?.status === "building" ? "Building service" : "Waiting for deployment" };
  if (row && isServiceSuccessStatus(row.status))
    return { status: "completed" as const, conclusion: "success" as const, title: "Service deployed" };
  if (parent.conclusion === "neutral") return { ...parent, title: "Unchanged service" };
  return {
    status: "completed" as const,
    conclusion: parent.conclusion === "cancelled" ? "cancelled" as const : "failure" as const,
    title: "Service was not deployed",
  };
}

async function deliver(root: DeploymentCheck, lease: string): Promise<{ done: boolean; error?: string; unavailable?: boolean }> {
  const source = root.source;
  if (!source) return { done: true };
  const dep = await repos.deployment.findById(root.deploymentId);
  if (!dep) return { done: true };
  const project = await repos.project.findByIdInOrganization(dep.projectId, dep.organizationId);
  if (!project || project.deletedAt || project.gitProvider !== "github" ||
    project.gitOwner?.toLowerCase() !== source.owner.toLowerCase() || project.gitRepo?.toLowerCase() !== source.repo.toLowerCase())
    return { done: true, error: "The project source changed; GitHub reporting for this deployment stopped." };
  const rows = await repos.serviceDeployment.listByDeployment(dep.id);
  let parent = deploymentCheckOutcome(dep, await repos.deployment.hasLiveBuildExecution(dep.id, dep.projectId));
  if (parent.conclusion === "success" && rollupDeploymentStatus(rows) !== "ready")
    parent = { status: "completed", conclusion: "failure", title: "Some services failed" };
  if (!dep.commitSha || !/^[a-f\d]{40}$/i.test(dep.commitSha))
    return { done: parent.status === "completed", ...(parent.status === "completed" && { error: "No exact Git commit was captured for this deployment. No Check was published." }) };
  const owner = await resolveOrgOwner(dep.organizationId);
  if (!owner) return { done: false, error: "GitHub reporting needs an active organization owner.", unavailable: true };
  const ctx = buildBackgroundContext({ userId: owner.userId, organizationId: dep.organizationId, label: "deployment:github-checks" });
  const base = runtimeTarget.dashboard.replace(/\/$/, "");
  const detailsUrl = `${base}/build/${encodeURIComponent(dep.id)}`;
  const secrets = Object.values(dep.envVars ?? {});
  // Service environments are captured with the attempt, not read from today's
  // project config after a credential rotation.
  const meta = dep.meta as { composeServices?: Array<{ environment?: Record<string, unknown> }> } | null;
  if (Array.isArray(meta?.composeServices)) for (const item of meta.composeServices) {
    if (item?.environment && typeof item.environment === "object")
      secrets.push(...Object.values(item.environment).filter((value): value is string => typeof value === "string"));
  }
  const summary = (fallback: string, error?: string | null) => source.checks.includeErrors && error
    ? `${fallback}\n\n${checkFailureSummary(error, secrets)}` : fallback;
  const existing = await repos.deploymentCheck.list(dep.id);
  const targets: Array<{ check: DeploymentCheck; outcome: ReturnType<typeof serviceCheckOutcome>; error?: string | null; serviceDeploymentId?: string }> = [];
  if (source.checks.deployment) {
    const failed = parent.status === "completed" && !["success", "neutral"].includes(parent.conclusion ?? "");
    // The rollup remains useful when the user turns off individual service
    // Checks. Include bounded failure reasons, never the service build logs.
    const failures = rows.filter(row => isServiceFailureStatus(row.status)).slice(0, 10)
      .map(row => `${row.serviceName}: ${checkFailureSummary(row.errorMessage ?? row.error ?? row.status, secrets)}`);
    targets.push({ check: root, outcome: parent, error: failed ? [dep.errorMessage, ...failures].filter(Boolean).join("\n") : null });
  }
  const services = new Map(source.services.map(service => [service.name, service]));
  // Rows belong to this attempt, so late source discovery can add a service
  // without consulting mutable project settings or reporting unrelated apps.
  for (const row of rows) if (row.serviceName && !services.has(row.serviceName))
    services.set(row.serviceName, { name: row.serviceName, targeted: row.status !== "skipped" });
  for (const service of services.values()) {
    if (source.checks.services !== "all" && !source.checks.services.includes(service.name)) continue;
    const row = rows.find(row => row.serviceName === service.name);
    const check = existing.find(check => check.serviceName === service.name)
      ?? await repos.deploymentCheck.ensureService(root, service.name);
    const outcome = serviceCheckOutcome(row, service.targeted, parent);
    const failed = outcome.status === "completed" && !["success", "neutral", "skipped"].includes(outcome.conclusion ?? "");
    targets.push({ check, outcome, error: failed ? row?.errorMessage ?? row?.error ?? dep.errorMessage : null, serviceDeploymentId: row?.id });
  }
  // Disabling while an attempt is running closes already-created Checks, and
  // never creates another one. Preferences otherwise apply at the next admission.
  const disabled = project.githubChecks?.enabled === false;
  for (const target of targets) {
    const outcome = disabled ? { status: "completed" as const, conclusion: "neutral" as const, title: "GitHub deployment reporting disabled" } : target.outcome;
    const update: GitHubCheckUpdate = {
      name: target.check.name, externalId: `openship-deployment:${dep.id}:${target.check.id}`, headSha: dep.commitSha,
      status: outcome.status, ...(outcome.status === "completed" && { conclusion: outcome.conclusion }),
      detailsUrl, startedAt: dep.createdAt.toISOString(),
      ...(outcome.status === "completed" && { completedAt: dep.updatedAt.toISOString() }),
      output: { title: outcome.title, summary: summary(outcome.title, disabled ? null : target.error) },
    };
    const digest = createHash("sha256").update(JSON.stringify(update)).digest("hex");
    if (digest === target.check.publishedDigest) continue;
    if (!nativeJobsEnabled() || !await repos.deploymentCheck.renew(root.id, lease)) return { done: false };
    const result = await syncGitHubCheck(ctx, source.owner, source.repo, target.check.checkRunId?.toString() ?? null, update, {
      canSend: async () => nativeJobsEnabled() && await repos.deploymentCheck.renew(root.id, lease),
      // Recover a Check accepted before a lost response, even if the user has
      // since disabled reporting. Close it without creating a new Check.
      createIfMissing: !disabled,
    });
    if (result.skipped) continue;
    if (result.error || !result.id) return { done: false, error: result.error ?? "GitHub did not confirm the Check.", unavailable: result.unavailable };
    if (!await repos.deploymentCheck.published(root.id, lease, target.check.id, {
      checkRunId: Number(result.id), status: update.status, conclusion: update.conclusion ?? null, publishedDigest: digest,
      ...(target.serviceDeploymentId && { serviceDeploymentId: target.serviceDeploymentId }),
    })) return { done: false };
  }
  return { done: disabled || parent.status === "completed" };
}

/** Existing scheduler owns lifetime/quiescence; no request or build awaits GitHub. */
export async function runDeploymentChecksSweep() {
  if (!nativeJobsEnabled()) return { processed: 0, failed: 0 };
  const due = await repos.deploymentCheck.due();
  let processed = 0, failed = 0;
  // Bound parallelism and memory even on an instance with many organizations.
  const queue = [...due];
  await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => {
    while (queue.length && nativeJobsEnabled()) {
      const next = queue.shift()!;
      const token = randomUUID();
      const root = await repos.deploymentCheck.claim(next.id, token);
      if (!root) continue;
      let result: Awaited<ReturnType<typeof deliver>>;
      try { result = await deliver(root, token); }
      catch (error) {
        diagnostics.warn("deployments/github-checks", "Deployment Check delivery will be retried", error, { deploymentId: root.deploymentId });
        result = { done: false, error: checkFailureSummary(safeErrorMessage(error)) };
      }
      const attempts = result.error ? root.attempts + 1 : 0;
      const expired = Date.now() - root.createdAt.getTime() > RETRY_WINDOW_MS;
      const delay = result.unavailable ? 15 * 60_000 : result.error ? Math.min(300_000, 15_000 * 2 ** Math.min(attempts, 5)) : 10_000;
      await repos.deploymentCheck.release(root.id, token, {
        attempts, lastError: result.error ?? null,
        nextAttemptAt: result.done || (expired && !!result.error) ? null : new Date(Date.now() + delay),
      });
      processed++;
      if (result.error) failed++;
    }
  }));
  return { processed, failed };
}
