import { AppError } from "./errors";

/** A managed Cloud controller must never become a tenant's workload host.
 * Check at use time, including for executors created before configuration loads.
 * Remote provider/SSH executors do not use this local-only policy. */
export function isLocalHostExecutionAllowed(): boolean {
  const mode = process.env.CLOUD_MODE?.trim().toLowerCase();
  return mode !== "true" && mode !== "1";
}

export function assertLocalHostExecutionAllowed(): void {
  if (!isLocalHostExecutionAllowed()) {
    throw new AppError(
      "Local host execution is unavailable on the Cloud control plane. Use the selected server's scoped executor.",
      403,
      "LOCAL_HOST_ACCESS_DENIED",
    );
  }
}
