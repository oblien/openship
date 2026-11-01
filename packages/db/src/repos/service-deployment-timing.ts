import { sql } from "drizzle-orm";
import { isServiceFailureStatus, isServiceSuccessStatus } from "@repo/core";
import { serviceDeployment } from "../schema";

/** Finish the first measured build/deploy attempt in the same write as its
 * outcome. Runtime reconciliation and repeated outcome writes must not move
 * that clock. Rows without a recorded start retain unknown elapsed time; a
 * caller that knows when an unmeasured attempt finished may retain that fact. */
export function serviceDeploymentFinishPatch(
  status: string | undefined,
  now: Date,
  recordUnstartedFinish = false,
) {
  if (!isServiceSuccessStatus(status) && !isServiceFailureStatus(status) &&
    status !== "skipped" && status !== "cancelled" && status !== "indeterminate") return {};
  const finishedAt = sql`coalesce(${serviceDeployment.finishedAt}, ${now.toISOString()}::timestamp)`;
  return {
    startedAt: sql`${serviceDeployment.startedAt}`,
    finishedAt: recordUnstartedFinish ? finishedAt : sql`case when ${serviceDeployment.startedAt} is null
      then ${serviceDeployment.finishedAt} else ${finishedAt} end`,
    durationMs: sql`case when ${serviceDeployment.startedAt} is null
      then ${serviceDeployment.durationMs}
      else coalesce(${serviceDeployment.durationMs}, least(2147483647,
        greatest(0, floor(extract(epoch from
          (${finishedAt} - ${serviceDeployment.startedAt})) * 1000)))) end`,
  };
}
