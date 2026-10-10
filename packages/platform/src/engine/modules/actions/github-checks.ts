import { actionFinished, safeErrorMessage, AppError } from "@repo/core";
import type { ActionRun, ActionJob } from "@repo/db";
import { resolveExecutionAuthority } from "../../lib/execution-authority";
import { syncGitHubCheck, type GitHubCheckUpdate } from "../github/check-runs";
import { localDashboardUrl } from "../../config/env";
import { diagnostics } from "@repo/core/diagnostics";

/** Checks use the controller's App identity independently of the job credential. */
export async function syncActionCheck(run: ActionRun, job: ActionJob) {
  if (run.controller === "github") return { id: job.checkRunId, error: null, unavailable: true };
  const { owner, repo } = run.configuration;
  if (!owner || !repo) return { id: null, error: null, unavailable: true };
  const name = `Openship / ${run.plan.name} / ${job.spec?.name ?? job.jobKey}`.slice(0, 255);
  const externalId = `openship-action:${run.id}:${job.id}`;
  const id = job.checkRunId;
  try {
    const ctx = await resolveExecutionAuthority(run.authority, `actions-check:${run.id}`);
    const finished = actionFinished(job.status);
    const status = finished
      ? "completed"
      : job.status === "running" || job.status === "cancelling"
        ? "in_progress"
        : "queued";
    const conclusion = job.status as GitHubCheckUpdate["conclusion"];
    const base = (process.env.OPENSHIP_PUBLIC_URL || localDashboardUrl)?.replace(/\/$/, "");
    const update: GitHubCheckUpdate = {
      name,
      externalId,
      headSha: run.revision,
      status,
      ...(base && { detailsUrl: `${base}/actions/runs/${run.id}` }),
      ...(job.startedAt && { startedAt: job.startedAt.toISOString() }),
      ...(finished && { conclusion, completedAt: (job.finishedAt ?? new Date()).toISOString() }),
      output: {
        title: `${run.plan.name} · ${job.spec?.name ?? job.jobKey}`.slice(0, 255),
        summary: job.error?.slice(0, 4096) || `Openship Actions: ${job.status}.`,
      },
    };
    return await syncGitHubCheck(ctx, owner, repo, id, update);
  } catch (error) {
    // Revocation cancels execution and must also terminate this delegation's
    // background writes. Retrying a removed actor forever would strand history.
    const unavailable = error instanceof AppError && [401, 403, 404].includes(error.statusCode);
    diagnostics.warn(
      "actions/checks",
      unavailable ? "GitHub Check access is unavailable" : "GitHub Check update will be retried",
      error,
      { runId: run.id, jobId: job.id },
    );
    return { id, error: safeErrorMessage(error), ...(unavailable && { unavailable: true }) };
  }
}
