import { actionFinished, safeErrorMessage, AppError } from "@repo/core";
import type { ActionRun, ActionJob } from "@repo/db";
import { resolveExecutionAuthority } from "../../lib/execution-authority";
import { githubFetch, getInstallationToken } from "../github/github.auth";
import { localDashboardUrl } from "../../config/env";
import { diagnostics } from "@repo/core/diagnostics";

/** Checks use the controller's App identity independently of the job credential. */
export async function syncActionCheck(run: ActionRun, job: ActionJob) {
  const { owner, repo } = run.configuration;
  if (!owner || !repo) return { id: null, error: null, unavailable: true };
  const name = `Openship / ${run.plan.name} / ${job.spec?.name ?? job.jobKey}`.slice(0, 255);
  const externalId = `openship-action:${run.id}:${job.id}`;
  let id = job.checkRunId;
  try {
    const ctx = await resolveExecutionAuthority(run.authority, `actions-check:${run.id}`);
    const token = await getInstallationToken(ctx, owner, undefined, { repositories: [repo] });
    if (!token)
      return { id, error: "Connect a GitHub App to publish workflow Checks.", unavailable: true };
    const root = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
    const request = <T>(
      url: string,
      method: "GET" | "POST" | "PATCH" = "GET",
      params?: Record<string, unknown>,
    ) =>
      githubFetch<T>({ ctx, owner, repo, url, method, params, credential: ["app-installation"] });
    if (!id) {
      // A response can be lost after GitHub accepted creation. Search our stable
      // identity before creating; an API restart never blindly duplicates Checks.
      for (let page = 1; page <= 10; page++) {
        const result = await request<{
          check_runs: Array<{ id: number; external_id: string }>;
          total_count: number;
        }>(
          `${root}/commits/${run.revision}/check-runs?filter=all&per_page=100&page=${page}&check_name=${encodeURIComponent(name)}`,
        );
        id =
          result.check_runs.find((check) => check.external_id === externalId)?.id.toString() ??
          null;
        if (id || result.check_runs.length < 100) break;
        if (page === 10)
          throw new Error("Too many matching Checks to safely identify this attempt");
      }
    }
    const finished = actionFinished(job.status);
    const status = finished
      ? "completed"
      : job.status === "running" || job.status === "cancelling"
        ? "in_progress"
        : "queued";
    const conclusion = job.status === "timed_out" ? "timed_out" : job.status;
    const base = (process.env.OPENSHIP_PUBLIC_URL || localDashboardUrl)?.replace(/\/$/, "");
    const body = {
      name,
      external_id: externalId,
      status,
      ...(base && { details_url: `${base}/actions/runs/${run.id}` }),
      ...(job.startedAt && { started_at: job.startedAt.toISOString() }),
      ...(finished && { conclusion, completed_at: (job.finishedAt ?? new Date()).toISOString() }),
      output: {
        title: `${run.plan.name} · ${job.spec?.name ?? job.jobKey}`.slice(0, 255),
        summary: job.error?.slice(0, 4096) || `Openship Actions: ${job.status}.`,
      },
    };
    if (id) await request(`${root}/check-runs/${id}`, "PATCH", body);
    else
      id = String(
        (
          await request<{ id: number }>(`${root}/check-runs`, "POST", {
            ...body,
            head_sha: run.revision,
          })
        ).id,
      );
    return { id, error: null };
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
