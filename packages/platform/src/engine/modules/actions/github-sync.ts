import { randomUUID } from "node:crypto";
import {
  AppError,
  ACTIONS_MAX_JOB_SECONDS,
  safeErrorMessage,
  type ActionJobDefinition,
  type ActionStatus,
} from "@repo/core";
import { repos, githubActionRunId, githubActionJobId, type ActionWorkflow } from "@repo/db";
import { diagnostics } from "@repo/core/diagnostics";
import type { ExecutionContext } from "../../../context";
import { resolveExecutionAuthority } from "../../lib/execution-authority";
import { getFileContent } from "../github/github.service";
import { authorizeActionWorkflow } from "./access";
import { GitHubActionsApi, type GitHubWorkflowRun, type GitHubWorkflowJob } from "./github-api";
import { parseActionWorkflow } from "./workflow";

export function githubActionStatus(status: string, conclusion: string | null): ActionStatus {
  if (status !== "completed") {
    if (status === "in_progress") return "running";
    if (["waiting", "pending", "action_required"].includes(status)) return "waiting";
    return "queued";
  }
  switch (conclusion) {
    case "success":
      return "success";
    case "cancelled":
      return "cancelled";
    case "timed_out":
      return "timed_out";
    case "neutral":
    case "skipped":
      return "skipped";
    default:
      return "failure";
  }
}

export function assertGitHubWorkflowRun(workflow: ActionWorkflow, run: GitHubWorkflowRun) {
  if (
    workflow.controller !== "github" ||
    String(run.workflow_id) !== workflow.githubWorkflowId ||
    run.repository.full_name.toLowerCase() !== `${workflow.owner}/${workflow.repo}`.toLowerCase() ||
    run.path.split("@")[0] !== workflow.path
  )
    throw new AppError(
      "GitHub returned a run belonging to a different workflow",
      502,
      "ACTIONS_GITHUB_IDENTITY_MISMATCH",
    );
  const url = new URL(run.html_url);
  if (
    url.origin !== "https://github.com" ||
    url.pathname.toLowerCase() !==
      `/${workflow.owner}/${workflow.repo}/actions/runs/${run.id}`.toLowerCase()
  )
    throw new AppError(
      "GitHub returned an invalid workflow URL",
      502,
      "ACTIONS_GITHUB_IDENTITY_MISMATCH",
    );
}

/** Project checks and the Actions screen consume the same persisted GitHub
 * response. Webhook payloads only request reconciliation, never grant success. */
export async function synchronizeGitHubRun(
  ctx: ExecutionContext,
  workflow: ActionWorkflow,
  remote: GitHubWorkflowRun,
  api = new GitHubActionsApi(ctx, workflow.owner!, workflow.repo!),
) {
  assertGitHubWorkflowRun(workflow, remote);
  const id = githubActionRunId(workflow.organizationId, String(remote.id), remote.run_attempt);
  const previous = await repos.actions.run(workflow.organizationId, id);
  const command = await repos.actions.gitHubRunCommand(
    workflow.organizationId,
    workflow.id,
    String(remote.id),
    remote.run_attempt,
  );
  const sourceJob = previous?.configuration.sourceJob ?? command?.sourceJob ?? undefined;
  const newlyLinkedJob = sourceJob && !previous?.configuration.sourceJob;
  if (previous?.settledAt && previous.github?.updatedAt === remote.updated_at && !newlyLinkedJob)
    return previous;
  const source =
    previous?.source ??
    (
      await getFileContent(ctx, workflow.owner!, workflow.repo!, workflow.path, {
        branch: remote.head_sha,
      })
    ).content;
  const definition = await parseActionWorkflow(source, workflow.path, "github");
  const remoteJobs = await api.jobs(String(remote.id), remote.run_attempt);
  const logical = new Map<string, ActionJobDefinition>();
  for (const job of remoteJobs) {
    if (
      job.run_id !== remote.id ||
      job.run_attempt !== remote.run_attempt ||
      job.head_sha !== remote.head_sha
    )
      throw new AppError(
        "GitHub returned a job from a different run",
        502,
        "ACTIONS_GITHUB_IDENTITY_MISMATCH",
      );
    const match = definition.jobs.filter(
      (candidate) =>
        candidate.name === job.name ||
        candidate.id === job.name ||
        (candidate.uses &&
          [candidate.name, candidate.id].some((name) => job.name.startsWith(`${name} / `))) ||
        (candidate.matrix &&
          !candidate.name.includes("${{") &&
          job.name.startsWith(`${candidate.name} (`)),
    );
    if (match.length === 1) logical.set(String(job.id), match[0]!);
  }
  // REST job IDs remain stable when display names or matrix values collide.
  // Preserve dependencies only when their source identities are unambiguous.
  const plan = {
    ...definition,
    jobs: remoteJobs.map((job): ActionJobDefinition => {
      const original = logical.get(String(job.id));
      return {
        ...original,
        id: `github_${job.id}`,
        name: job.name,
        runsOn: job.labels,
        needs: remoteJobs
          .filter((parent) => original?.needs.includes(logical.get(String(parent.id))?.id ?? ""))
          .map((parent) => `github_${parent.id}`),
        failFast: false,
        maxParallel: 1,
        timeoutMinutes: ACTIONS_MAX_JOB_SECONDS / 60,
        continueOnError: false,
        requiresDocker: false,
      };
    }),
  };
  const finishedAt = remote.status === "completed" ? new Date(remote.updated_at) : null;
  const ref = previous?.ref ?? (await resolveGitHubRunRef(remote, api));
  const complete =
    finishedAt &&
    remoteJobs.every((job) => job.status === "completed") &&
    !(await repos.actions.gitHubRunHasAllocations(workflow.organizationId, id));
  const settledAt =
    complete && !sourceJob ? finishedAt : !newlyLinkedJob ? (previous?.settledAt ?? null) : null;
  const saved = await repos.actions.upsertGitHubRun(
    workflow,
    {
      id,
      organizationId: workflow.organizationId,
      workflowId: workflow.id,
      controller: "github",
      github: {
        id: String(remote.id),
        workflowId: String(remote.workflow_id),
        url: remote.html_url,
        status: remote.status,
        conclusion: remote.conclusion,
        updatedAt: remote.updated_at,
      },
      number: remote.run_number,
      attempt: remote.run_attempt,
      idempotencyKey: `github:${remote.id}:${remote.run_attempt}`,
      source,
      plan,
      authority: workflow.authority,
      status: githubActionStatus(remote.status, remote.conclusion),
      configuration: {
        owner: workflow.owner,
        repo: workflow.repo,
        path: workflow.path,
        defaultBranch: remote.repository.default_branch ?? workflow.ref,
        runnerIds: workflow.runnerIds,
        variables: {},
        secrets: {},
        sourceJob,
        workflowVersion:
          new Date(remote.created_at) >= workflow.updatedAt
            ? workflow.updatedAt.toISOString()
            : undefined,
      },
      revision: remote.head_sha,
      ref,
      eventName: remote.event,
      event: {},
      actor: remote.actor?.login ?? "github",
      untrusted: remote.head_repository?.id !== remote.repository.id,
      startedAt: remote.run_started_at ? new Date(remote.run_started_at) : null,
      finishedAt,
      settledAt,
      createdAt: new Date(remote.created_at),
    },
    remoteJobs.map((job) => githubJobMirror(workflow, id, job)),
    previous?.updatedAt ?? null,
  );
  if (complete && saved.finishedAt && !saved.settledAt && saved.configuration.sourceJob) {
    const lease = `github-completion-${randomUUID()}`;
    const claimed = await repos.actions.claimRun(workflow.organizationId, id, lease);
    if (claimed) {
      try {
        await (await import("../jobs/job-workflow")).workflowJobCompleted(claimed);
        await repos.actions.updateRun(workflow.organizationId, id, lease, {
          settledAt: new Date(),
        });
      } finally {
        await repos.actions.releaseRun(workflow.organizationId, id, lease);
      }
    }
  }
  return (await repos.actions.run(workflow.organizationId, id))!;
}

/** head_branch can name a branch OR a tag. Ambiguous refs must never satisfy a
 * branch deployment gate. Preserve a resolved ref when the branch later moves. */
export async function resolveGitHubRunRef(run: GitHubWorkflowRun, api: GitHubActionsApi) {
  if (run.event.startsWith("pull_request") && run.pull_requests?.length === 1)
    return `refs/pull/${run.pull_requests[0]!.number}/${run.event === "pull_request_target" ? "base" : "merge"}`;
  if (!run.head_branch) return `refs/unknown/${run.head_sha}`;
  if (run.event === "release") return `refs/tags/${run.head_branch}`;
  const refs = await api.matchingRefs(run.head_branch);
  const heads = refs.includes(`refs/heads/${run.head_branch}`);
  const tags = refs.includes(`refs/tags/${run.head_branch}`);
  if (heads && !tags) return `refs/heads/${run.head_branch}`;
  if (tags && !heads) return `refs/tags/${run.head_branch}`;
  return `refs/unknown/${run.head_branch}`;
}

function githubJobMirror(workflow: ActionWorkflow, runId: string, job: GitHubWorkflowJob) {
  const status = githubActionStatus(job.status, job.conclusion);
  const finishedAt =
    job.status === "completed" ? new Date(job.completed_at ?? job.started_at ?? Date.now()) : null;
  const url = new URL(job.html_url);
  if (
    url.origin !== "https://github.com" ||
    !url.pathname
      .toLowerCase()
      .startsWith(
        `/${workflow.owner}/${workflow.repo}/actions/runs/${job.run_id}/job/`.toLowerCase(),
      )
  )
    throw new AppError(
      "GitHub returned a job from another repository",
      502,
      "ACTIONS_GITHUB_IDENTITY_MISMATCH",
    );
  const check = new URL(job.check_run_url);
  if (
    check.origin !== "https://api.github.com" ||
    !check.pathname
      .toLowerCase()
      .startsWith(`/repos/${workflow.owner}/${workflow.repo}/check-runs/`.toLowerCase())
  )
    throw new AppError(
      "GitHub returned a check from another repository",
      502,
      "ACTIONS_GITHUB_IDENTITY_MISMATCH",
    );
  return {
    id: githubActionJobId(workflow.organizationId, String(job.id)),
    organizationId: workflow.organizationId,
    runId,
    github: {
      id: String(job.id),
      url: job.html_url,
      runnerId: job.runner_id ? String(job.runner_id) : null,
      runnerName: job.runner_name,
      steps: job.steps.map((step) => ({
        number: step.number,
        name: step.name,
        status: step.status,
        conclusion: step.conclusion,
        startedAt: step.started_at ?? null,
        finishedAt: step.completed_at ?? null,
      })),
    },
    jobKey: `github_${job.id}`,
    matrixIndex: 0,
    status,
    // GitHub evaluates step conditions and service requirements. Inferring
    // them here would block a Mac job whose Linux-only Docker step is skipped.
    spec: {
      jobId: `github_${job.id}`,
      name: job.name,
      labels: job.labels,
      matrix: {},
      strategy: {},
      needs: {},
      timeoutSeconds: ACTIONS_MAX_JOB_SECONDS,
      continueOnError: false,
      failFast: false,
      maxParallel: 1,
      concurrency: null,
      permissions: {},
      requiresDocker: false,
    },
    checkRunId: check.pathname.split("/").at(-1)!,
    checkError: null,
    error: null,
    startedAt: job.started_at ? new Date(job.started_at) : null,
    finishedAt,
    cleanedAt: finishedAt,
    result: finishedAt
      ? {
          conclusion: status as "success" | "failure" | "cancelled" | "skipped" | "timed_out",
          outputs: {},
          steps: Object.fromEntries(
            job.steps.map((step) => [
              String(step.number),
              {
                outcome: step.conclusion ?? step.status,
                conclusion: step.conclusion ?? step.status,
              },
            ]),
          ),
        }
      : null,
  };
}

export async function synchronizeGitHubWorkflow(ctx: ExecutionContext, workflow: ActionWorkflow) {
  await authorizeActionWorkflow(ctx, workflow, true);
  const api = new GitHubActionsApi(ctx, workflow.owner!, workflow.repo!);
  const remote = await api.runs(workflow.githubWorkflowId!);
  const seen = new Set<string>();
  for (const run of remote) {
    if (run.status === "completed" && Date.parse(run.updated_at) < Date.now() - 30 * 86_400_000)
      continue;
    await synchronizeGitHubRun(ctx, workflow, run, api);
    seen.add(`${run.id}:${run.run_attempt}`);
  }
  for (const pending of await repos.actions.pendingGitHubRuns(
    workflow.organizationId,
    workflow.id,
  )) {
    if (!pending.github || seen.has(`${pending.github.id}:${pending.attempt}`)) continue;
    await synchronizeGitHubRun(
      ctx,
      workflow,
      await api.attempt(pending.github.id, pending.attempt),
      api,
    );
  }
}

const controllerId = `github-actions-${randomUUID()}`;
export async function reconcileGitHubWorkflows(signal?: AbortSignal) {
  for (const candidate of await repos.actions.pendingGitHubWorkflows()) {
    if (signal?.aborted) return;
    const workflow = await repos.actions.claimGitHubSync(
      candidate.organizationId,
      candidate.id,
      controllerId,
    );
    if (!workflow) continue;
    let lost = false;
    const timer = setInterval(() => {
      void repos.actions
        .claimGitHubSync(workflow.organizationId, workflow.id, controllerId)
        .then((row) => {
          if (!row) lost = true;
        })
        .catch((error) => {
          lost = true;
          diagnostics.warn(
            "actions/github-sync",
            "GitHub synchronization lease could not be renewed",
            error,
            { workflowId: workflow.id },
          );
        });
    }, 30_000);
    timer.unref?.();
    try {
      const ctx = await resolveExecutionAuthority(
        workflow.authority,
        `github-actions:${workflow.id}`,
      );
      await synchronizeGitHubWorkflow(ctx, workflow);
      if (!lost)
        await repos.actions.finishGitHubSync(
          workflow.organizationId,
          workflow.id,
          controllerId,
          null,
        );
    } catch (error) {
      if (!lost)
        await repos.actions.finishGitHubSync(
          workflow.organizationId,
          workflow.id,
          controllerId,
          safeErrorMessage(error),
          60_000,
        );
      diagnostics.warn(
        "actions/github-sync",
        "GitHub workflow state could not be refreshed",
        error,
        { workflowId: workflow.id },
      );
    } finally {
      clearInterval(timer);
    }
  }
}
