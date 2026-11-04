/** One output, checkpoint and terminal-write path for commands and host maintenance.
 * Step events come from the same PipelineLogger used by deployments. */
import { reportCaughtError, diagnostics } from "@repo/core/diagnostics";
import { safeErrorMessage, type LogEntry } from "@repo/core";
import type { JobRunStep } from "@repo/contracts";
import { repos } from "@repo/db";
import { boundedStorableText } from "../deployments/build-log-sanitize";
import { jobRunBus } from "./job-run.sse";

export const MAX_RUN_OUTPUT = 200_000;
const MAX_ERROR = 4_096;
const OUTPUT_UNSTORABLE =
  "[output omitted — the captured command output could not be stored; see server logs]";
const ERROR_UNSTORABLE = "Command failed (details could not be stored; see server logs)";
type FinishData = Parameters<typeof repos.jobRun.finish>[1];
const storableSummary = (summary: Record<string, unknown> | undefined) =>
  summary === undefined
    ? undefined
    : (JSON.parse(
        JSON.stringify(summary, (_key, value) =>
          typeof value === "string" ? boundedStorableText(value, MAX_ERROR) : value,
        ),
      ) as Record<string, unknown>);

/** Preserve the outcome even if captured remote text cannot be written. Never reruns work. */
export async function finishJobRun(runId: string, jobKey: string, data: FinishData): Promise<void> {
  const clean = {
    ...data,
    summary: storableSummary(data.summary),
    ...(data.output === undefined
      ? {}
      : { output: boundedStorableText(data.output, MAX_RUN_OUTPUT) }),
    ...(data.error === undefined ? {} : { error: boundedStorableText(data.error, MAX_ERROR) }),
  };
  const attempts: FinishData[] = [
    clean,
    { ...clean, output: OUTPUT_UNSTORABLE },
    {
      ...clean,
      output: OUTPUT_UNSTORABLE,
      error: data.status === "failed" ? ERROR_UNSTORABLE : undefined,
    },
  ];
  let persisted = false;
  for (const attempt of attempts) {
    try {
      await repos.jobRun.finish(runId, attempt);
      persisted = true;
      break;
    } catch (error) {
      reportCaughtError(error, "jobs.run-finish");
    }
  }
  if (!persisted)
    diagnostics.error(
      "jobs.run-finish",
      `Run ${jobKey}/${runId} could not store its terminal outcome; recovery must reconcile it.`,
    );
  try {
    jobRunBus.publish(runId, { type: "complete", status: data.status, error: clean.error });
  } catch (error) {
    reportCaughtError(error, "jobs.run-complete");
  }
}

export function createJobRunRecorder(
  run: { id: string; jobId: string; startedAt: Date; output?: string | null },
  initialSummary: Record<string, unknown> = {},
) {
  let summary = { ...initialSummary };
  let output = boundedStorableText(run.output ?? "", MAX_RUN_OUTPUT);
  let pending: Promise<void> = Promise.resolve();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  let dirty = false;
  let logSeq = Number(initialSummary.logSeq ?? 0);

  const flush = () => {
    clearTimeout(timer);
    timer = undefined;
    pending = pending
      .then(async () => {
        if (!dirty) return;
        dirty = false;
        await repos.jobRun.progress(run.id, storableSummary(summary)!, output);
      })
      .catch((error) => {
        reportCaughtError(error, "jobs.run-checkpoint");
      });
    return pending;
  };
  const schedule = () => {
    dirty = true;
    if (!timer && !closed) {
      timer = setTimeout(() => {
        void flush();
      }, 2000);
      timer.unref?.();
    }
  };
  const progress = async (patch: Record<string, unknown>) => {
    summary = { ...summary, ...patch };
    dirty = true;
    await flush();
  };
  const onLog = (entry: LogEntry<string>) => {
    if (closed) return;
    const line = boundedStorableText(entry.message, MAX_RUN_OUTPUT);
    // Only new bytes need sanitizing; rescanning a full 200 kB buffer on every
    // line makes chatty command jobs needlessly expensive. Keep the tail pair-safe.
    output = (output + line + "\n").slice(-MAX_RUN_OUTPUT);
    const first = output.charCodeAt(0);
    if (first >= 0xdc00 && first <= 0xdfff) output = output.slice(1);
    if (entry.step && entry.stepStatus) {
      const steps = (summary.steps as JobRunStep[] | undefined) ?? [];
      const existing = steps.find((step) => step.id === entry.step);
      summary = {
        ...summary,
        steps: [
          ...steps.filter((step) => step.id !== entry.step),
          { id: entry.step, label: existing?.label ?? line, status: entry.stepStatus },
        ],
      };
      // Keep the declared step order, including pending checks.
      if (existing)
        (summary.steps as JobRunStep[]).sort(
          (a, b) =>
            steps.findIndex((step) => step.id === a.id) -
            steps.findIndex((step) => step.id === b.id),
        );
    }
    summary = { ...summary, logSeq: ++logSeq };
    jobRunBus.publish(run.id, { type: "log", line, level: entry.level, seq: logSeq });
    schedule();
    if (entry.step) void flush();
  };
  return {
    onLog,
    progress,
    flush,
    get output() {
      return output;
    },
    get summary() {
      return summary;
    },
    async suspend(patch: Record<string, unknown>) {
      closed = true;
      await progress(patch);
    },
    async finish(
      status: "success" | "failed",
      patch: Record<string, unknown> = {},
      error?: unknown,
      finalOutput?: string,
    ) {
      closed = true;
      await flush();
      summary = { ...summary, ...patch };
      if (finalOutput !== undefined) output = boundedStorableText(finalOutput, MAX_RUN_OUTPUT);
      if (status === "failed")
        summary.steps = (summary.steps as JobRunStep[] | undefined)?.map((step) =>
          step.status === "running"
            ? { ...step, status: "failed" }
            : step.status === "pending"
              ? { ...step, status: "skipped" }
              : step,
        );
      await finishJobRun(run.id, run.jobId, {
        status,
        summary,
        output,
        durationMs: Date.now() - run.startedAt.getTime(),
        ...(error === undefined ? {} : { error: safeErrorMessage(error) }),
      });
    },
  };
}
