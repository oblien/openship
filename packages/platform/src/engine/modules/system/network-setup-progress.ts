import type { SetupStepProgress, SetupLog } from "@repo/core";
import { boundedStorableText, sanitizeLogText } from "../deployments/build-log-sanitize";

type ProgressHost<Id extends string> = { steps?: SetupStepProgress<Id>[]; logs?: SetupLog<Id>[] };

/** Bound and sanitize before persistence; package repositories may contain credentials. */
export function networkSetupMessage(message: string): string {
  return boundedStorableText(sanitizeLogText(message), 2000);
}
export function appendNetworkSetupLog<Id extends string>(
  host: ProgressHost<Id>,
  step: Id,
  entry: { message: string; level: SetupLog["level"]; timestamp?: string },
) {
  const message = networkSetupMessage(entry.message);
  if (!message.trim()) return;
  host.logs ??= [];
  host.logs.push({
    step,
    message,
    level: entry.level,
    timestamp: entry.timestamp ?? new Date().toISOString(),
  });
  if (host.logs.length > 300) host.logs.splice(0, host.logs.length - 300);
}
export function updateNetworkSetupStep<Id extends string>(
  host: ProgressHost<Id>,
  id: Id,
  status: SetupStepProgress["status"],
  message?: string,
) {
  host.steps ??= [];
  let step = host.steps.find((item) => item.id === id);
  if (!step) {
    step = { id, status: "pending", message: null, startedAt: null, finishedAt: null };
    host.steps.push(step);
  }
  step.status = status;
  step.message = message ? networkSetupMessage(message) : null;
  if (status === "running") {
    step.startedAt = new Date().toISOString();
    step.finishedAt = null;
  } else if (status !== "pending") step.finishedAt = new Date().toISOString();
  if (message)
    appendNetworkSetupLog(host, id, { message, level: status === "failed" ? "error" : "info" });
}
