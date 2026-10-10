import { AppError, NotFoundError, type ActionWorkerEvent } from "@repo/core";
import type { ActionJob, ActionRun } from "@repo/db";
import type { ExecutionContext } from "../../../context";
import { GitHubActionsApi } from "./github-api";

function apiFor(ctx: ExecutionContext, run: ActionRun) {
  if (ctx.organizationId !== run.organizationId) throw new NotFoundError("Actions run");
  if (
    run.controller !== "github" ||
    !run.github ||
    !run.configuration.owner ||
    !run.configuration.repo
  )
    throw new Error("Invalid GitHub run");
  return new GitHubActionsApi(ctx, run.configuration.owner, run.configuration.repo);
}
export async function gitHubArtifacts(ctx: ExecutionContext, run: ActionRun) {
  return (await apiFor(ctx, run).artifacts(run.github!.id))
    .filter((item) => !item.expired)
    .map((item) => ({
      id: item.id,
      name: item.name,
      size: item.size_in_bytes,
      createdAt: item.created_at,
      expiresAt: item.expires_at,
    }));
}
export async function gitHubArtifactDownload(ctx: ExecutionContext, run: ActionRun, id: number) {
  // Artifact IDs are repository-wide: verify this run's membership before signing.
  if (!(await gitHubArtifacts(ctx, run)).some((item) => item.id === id))
    throw new NotFoundError("Actions artifact");
  return apiFor(ctx, run).redirect(`/actions/artifacts/${id}/zip`);
}
export async function gitHubJobEvents(
  ctx: ExecutionContext,
  run: ActionRun,
  job: ActionJob,
  after: number,
) {
  if (job.organizationId !== run.organizationId || job.runId !== run.id)
    throw new NotFoundError("Actions job");
  if (!job.github) throw new Error("Invalid GitHub job");
  // GitHub's public REST API supplies completed logs. Live output stays in its
  // authenticated UI; no scraping internal endpoints or storing runner tokens.
  if (!job.finishedAt) return { events: [], next: after, complete: false };
  const { url } = await apiFor(ctx, run).redirect(`/actions/jobs/${job.github.id}/logs`);
  const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(20_000) });
  if (!response.ok || !response.body)
    throw new AppError("GitHub job logs are not available yet", 503, "ACTIONS_LOGS_PENDING");
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let bytes = 0;
  let truncated = false;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const remaining = 8 * 1024 * 1024 - bytes;
      parts.push(chunk.value.subarray(0, remaining));
      bytes += Math.min(chunk.value.length, remaining);
      if (chunk.value.length > remaining || bytes === 8 * 1024 * 1024) {
        truncated = true;
        break;
      }
    }
  } finally {
    await reader.cancel();
  }
  const text =
    Buffer.concat(parts).toString("utf8") +
    (truncated ? "\nLog preview limited to 8 MiB. Open GitHub to download the full log.\n" : "");
  const chunks = text.match(/[\s\S]{1,16384}/g) ?? [];
  const events: ActionWorkerEvent[] = chunks.slice(after, after + 200).map((message, index) => ({
    version: 1,
    sequence: after + index + 1,
    time: job.finishedAt!.toISOString(),
    type: "log",
    message,
  }));
  const next = Math.max(after, after + events.length);
  return { events, next, complete: next >= chunks.length };
}
