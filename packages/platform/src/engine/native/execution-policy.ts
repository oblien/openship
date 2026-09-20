import { AppError } from "@repo/contracts";

/** Scheduled and detached backup work belongs to the explicitly started worker. */
export function nativeJobsEnabled(): boolean {
  return process.env.OPENSHIP_NATIVE !== "true" || process.env.OPENSHIP_NATIVE_JOBS === "true";
}

export function assertNativeJobs(): void {
  if (!nativeJobsEnabled())
    throw new AppError("Enable jobs when creating this native installation to execute jobs, backups, and restores", 409, "JOBS_DISABLED");
}

/** Resource authorization never implicitly grants access to the embedding host. */
export function assertNativeHostExecution(): void {
  if (!nativeHostExecutionEnabled())
    throw new AppError("Host execution is disabled by this native installation's policy", 403, "HOST_EXECUTION_DISABLED");
}

export function nativeHostExecutionEnabled(): boolean {
  return process.env.OPENSHIP_NATIVE !== "true" || process.env.OPENSHIP_NATIVE_ALLOW_HOST_EXECUTION === "true";
}

export function assertNativeLocalForwarding(): void {
  if (process.env.OPENSHIP_NATIVE === "true" && process.env.OPENSHIP_NATIVE_ALLOW_LOCAL_FORWARDING !== "true")
    throw new AppError("Local port forwarding is disabled by this native installation's policy", 403, "LOCAL_FORWARDING_DISABLED");
}

/** System SSH can read host keys/configuration and run local proxy commands. */
export function assertNativeSshSettings(settings: {
  sshAuthMethod?: string | null;
  sshPrivateKey?: string | null;
  sshKeyPath?: string | null;
}): void {
  if (settings.sshAuthMethod === "agent" ||
      (settings.sshAuthMethod === "key" && !settings.sshPrivateKey && settings.sshKeyPath))
    assertNativeHostExecution();
}
