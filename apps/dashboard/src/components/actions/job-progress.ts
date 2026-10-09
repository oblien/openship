import { actionFinished, type ActionStatus } from "@repo/core";
import type { ActionJobView, ActionOperations } from "@repo/contracts";

export type JobEvent = Awaited<ReturnType<ActionOperations["jobEvents"]>>["events"][number];

/** Rebuilt from the persisted event stream, including after a page refresh. */
export function jobProgress(events: JobEvent[], job: Pick<ActionJobView, "steps" | "status">) {
  const steps = new Map<string, { id: string; name: string; status: ActionStatus }>();
  for (const event of events) {
    if (!event.stepId || (event.stage && event.stage.toLowerCase() !== "main")) continue;
    const status =
      event.stepResult === "success"
        ? "success"
        : event.stepResult === "failure"
          ? "failure"
          : event.stepResult === "skipped"
            ? "skipped"
            : "running";
    const previous = steps.get(event.stepId);
    steps.set(event.stepId, {
      id: event.stepId,
      name: event.step ?? previous?.name ?? event.stepId,
      status: event.stepResult ? status : (previous?.status ?? status),
    });
  }
  for (const [id, step] of Object.entries(job.steps)) {
    const status =
      step.conclusion === "success"
        ? "success"
        : step.conclusion === "skipped"
          ? "skipped"
          : "failure";
    steps.set(id, { id, name: steps.get(id)?.name ?? id, status });
  }
  return [...steps.values()].map((step) =>
    step.status === "running" && actionFinished(job.status)
      ? { ...step, status: job.status }
      : step,
  );
}
