/** Evidence from one deployment attempt. Utilization and duration are not causes. */
export const DEPLOYMENT_RESOURCE_ISSUES = [
  "container-oom",
  "memory-allocation",
  "process-heap",
  "storage-full",
  "storage-low",
  "process-killed",
] as const;
export type DeploymentResourceIssue = (typeof DEPLOYMENT_RESOURCE_ISSUES)[number];
export const DEPLOYMENT_RESOURCE_FAILURE_CODE = "DEPLOYMENT_RESOURCE_FAILURE";

export function isDeploymentResourceIssue(value: unknown): value is DeploymentResourceIssue {
  return (
    typeof value === "string" && (DEPLOYMENT_RESOURCE_ISSUES as readonly string[]).includes(value)
  );
}

export function buildFailureExitCode(output: string): number | null {
  for (const match of output.matchAll(
    /(?:returned a non-zero code|exit(?:ed)? with(?: exit)? code|exit code)\s*:?\s*(\d+)\b/gi,
  )) {
    const code = Number(match[1]);
    if (code !== 0) return code;
  }
  return null;
}

/** Classify the actual failing operation, never arbitrary historical logs or a
 * high usage sample. A container OOM requires separate typed Docker evidence. */
export function deploymentResourceIssue(
  message: string,
  code?: string,
): DeploymentResourceIssue | null {
  if (code === "BUILD_STORAGE_LOW") return "storage-low";
  if (/no space left on device|\bENOSPC\b/i.test(message)) return "storage-full";
  if (
    /JavaScript heap out of memory|Ineffective mark-compacts near heap limit|Reached heap limit Allocation failed/i.test(
      message,
    )
  )
    return "process-heap";
  if (
    /\bENOMEM\b|cannot allocate memory|Fatal process out of memory|fatal error:\s*(?:runtime:\s*)?out of memory/i.test(
      message,
    )
  )
    return "memory-allocation";
  if (buildFailureExitCode(message) === 137) return "process-killed";
  return null;
}
