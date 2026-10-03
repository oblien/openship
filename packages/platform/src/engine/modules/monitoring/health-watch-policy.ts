import { env } from "../../config/env";
import { nativeJobsEnabled } from "../../native/execution-policy";

export const HEALTH_WATCH_JOB = "services:health-watch";

/** A deliberately stopped host (or one still starting) is not a Docker outage. */
export function isManagedServerIdle(error: unknown): boolean {
  return ["CLOUD_WORKSPACE_STOPPED", "CLOUD_WORKSPACE_STARTING"].includes(
    (error as { code?: string } | null)?.code ?? "",
  );
}

/** Desktop can use the same worker for as long as its API process is running. */
export function continuousHealthAvailable(): boolean {
  return nativeJobsEnabled();
}

export function containerHealthEventsAvailable(): boolean {
  return continuousHealthAvailable() && !env.OPENSHIP_DISABLE_CONTAINER_EVENTS;
}

export function healthWatchActive(
  job: {
    enabled: boolean;
    scheduleType: string;
    cronExpression: string | null;
  } | null,
): boolean {
  return (
    continuousHealthAvailable() &&
    !!job?.enabled &&
    job.scheduleType === "recurring" &&
    !!job.cronExpression
  );
}
