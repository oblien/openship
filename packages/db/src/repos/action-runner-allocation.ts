import { and, eq, sql } from "drizzle-orm";
import type { Database } from "../client";
import { actionRunner } from "../schema/actions";

/** Both controllers reserve the same physical capacity under the tenant lock.
 * GitHub's mirrored jobs are not allocations: their runner sessions are. */
export async function actionRunnerAllocationCount(
  db: Pick<Database, "select">,
  org: string,
  runner: { id: string; cloudPoolId: string | null },
): Promise<number> {
  const [row] = await db
    .select({
      value: sql<number>`(
    SELECT count(*) FROM action_job j INNER JOIN action_runner r ON r.id = j.runner_id
    WHERE j.organization_id = ${org} AND r.organization_id = ${org}
      AND j.cleaned_at IS NULL AND j.github IS NULL
      AND ${runner.cloudPoolId ? sql`r.cloud_pool_id = ${runner.cloudPoolId}` : sql`r.id = ${runner.id}`}
  ) + (
    SELECT count(*) FROM action_runner_session s INNER JOIN action_runner r ON r.id = s.runner_id
    WHERE s.organization_id = ${org} AND r.organization_id = ${org}
      AND s.cleaned_at IS NULL
      AND ${runner.cloudPoolId ? sql`r.cloud_pool_id = ${runner.cloudPoolId}` : sql`r.id = ${runner.id}`}
  )`,
    })
    .from(actionRunner)
    .where(and(eq(actionRunner.id, runner.id), eq(actionRunner.organizationId, org)));
  return Number(row?.value ?? 0);
}
