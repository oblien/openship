import {
  DEPLOYMENT_RESOURCE_FAILURE_CODE,
  deploymentResourceIssue,
  isDeploymentResourceIssue,
  type LogEntry,
} from "@repo/core";
import type { Project } from "@repo/db";

export interface DeploymentFailureMeta {
  errorCode?: string;
  errorDetails?: Record<string, unknown>;
}

/** Add public recovery data to the same outcome write. This observes an attempt;
 * it never changes admission, cleanup, readiness or billing policy. */
export function deploymentResourceFailure({
  project,
  message,
  meta,
  logs = [],
  cause,
  causes,
}: {
  project: Pick<Project, "id" | "workspaceId">;
  message: string;
  meta?: DeploymentFailureMeta;
  logs?: readonly LogEntry[];
  cause?: unknown;
  causes?: readonly unknown[];
}): DeploymentFailureMeta | undefined {
  if (!project.workspaceId) return meta;
  let code = meta?.errorCode;
  const seen = new Set<unknown>();
  const pending = causes ? causes.slice(0, 32) : [cause];
  while (pending.length && seen.size < 32) {
    const error = pending.shift();
    if (!(error instanceof Error) || seen.has(error)) continue;
    seen.add(error);
    const causeCode = (error as Error & { code?: unknown }).code;
    if (!code && typeof causeCode === "string" && /^[A-Za-z0-9_]{1,128}$/.test(causeCode))
      code = causeCode;
    pending.push(error.cause);
  }
  // A provider/network/permission/port error keeps its own recovery, even when
  // its explanation mentions memory or storage as a possible cause.
  if (code && code !== "BUILD_STORAGE_LOW" && code !== DEPLOYMENT_RESOURCE_FAILURE_CODE)
    return { ...meta, errorCode: code };
  let issue = isDeploymentResourceIssue(meta?.errorDetails?.resourceIssue)
    ? meta.errorDetails.resourceIssue
    : null;
  for (let index = logs.length - 1; !issue && index >= 0; index--) {
    const entry = logs[index]!;
    // Only runtime evidence attached to the actual failed operation qualifies.
    // An OOM warning from a different service must not explain this failure.
    if (entry.level === "error" && entry.resourceIssue && message.includes(entry.message.trim()))
      issue = entry.resourceIssue;
  }
  issue ??= deploymentResourceIssue(message, code);
  if (!issue) return meta;
  return {
    errorCode: code ?? DEPLOYMENT_RESOURCE_FAILURE_CODE,
    errorDetails: {
      ...meta?.errorDetails,
      resourceIssue: issue,
      projectId: project.id,
      workspaceId: project.workspaceId,
    },
  };
}
