import { diagnostics } from "@repo/core/diagnostics";
import { AppError } from "@repo/core";
import { repos } from "@repo/db";
import { nativeJobsEnabled } from "../../native/execution-policy";
import { trackBackgroundWork } from "../../lib/background-work";
import { actionController } from "./execution";

let timer: ReturnType<typeof setTimeout> | undefined;
let current: Promise<void> | undefined;
let shutdown: AbortController | undefined;
let stopped = true;
let schedulesAt = 0;
let poolsReady = false;
let retentionAt = 0;

export async function assertActionsTransferReady(): Promise<void> {
  if (
    (await repos.actions.unsettledRunCount()) ||
    (await repos.actions.runnerSessions()).length ||
    (await repos.actions.pendingActionDeploymentCount())
  )
    throw new AppError(
      "Finish or cancel active Actions runs before moving this instance. Their artifact connections must stay on the current controller until cleanup finishes.",
      409,
      "ACTIONS_INSTANCE_MOVE_BUSY",
    );
}
/** Only the active API/native controller starts this reconciler. Durable leases
 * arbitrate replicas; stopping this process does not kill destination workers. */
export function startActionController(): void {
  if (!stopped || !nativeJobsEnabled()) return;
  stopped = false;
  poolsReady = false;
  const abort = (shutdown = new AbortController());
  const tick = () => {
    if (stopped) return;
    current = trackBackgroundWork(
      (async () => {
        if (Date.now() - schedulesAt > 30_000) {
          schedulesAt = Date.now();
          if (!poolsReady) {
            try {
              await (await import("./cloud-runner")).ensureConfiguredActionPools();
              poolsReady = true;
            } catch (error) {
              diagnostics.warn("actions/pools", "Actions pool configuration failed", error);
            }
          }
          await (await import("./triggers")).dispatchActionSchedules();
          await (await import("./storage")).actionStorageProtocol().sweep();
          if (Date.now() - retentionAt > 3_600_000) {
            const cutoff = new Date(Date.now() - 30 * 86_400_000);
            await repos.actions.pruneDeliveries(cutoff);
            await repos.actions.pruneRuns(cutoff);
            retentionAt = Date.now();
          }
        }
        if (abort.signal.aborted) return;
        await (await import("./triggers")).actionWebhookInbox.tick();
        await actionController.tick(abort.signal);
        if (!abort.signal.aborted)
          await (await import("./github-sync")).reconcileGitHubWorkflows(abort.signal);
        if (!abort.signal.aborted)
          await (await import("./github-runners")).reconcileGitHubRunners(abort.signal);
        if (!abort.signal.aborted)
          await (await import("./deployment-gate")).actionDeploymentController.tick();
      })().catch((error) => diagnostics.warn("actions/controller", "Actions sweep failed", error)),
    );
    void current.finally(() => {
      current = undefined;
      if (!stopped) {
        timer = setTimeout(tick, 3000);
        timer.unref?.();
      }
    });
  };
  timer = setTimeout(tick, 0);
  timer.unref?.();
}
export async function stopActionController(timeoutMs?: number): Promise<void> {
  stopped = true;
  shutdown?.abort();
  if (timer) clearTimeout(timer);
  timer = undefined;
  if (!current) return;
  // Instance moves wait for full quiescence. Process shutdown can abandon this
  // controller's inspection after its grace period; the remote journal and DB
  // lease let its successor resume without replaying the running job.
  if (timeoutMs === undefined) {
    await current;
    return;
  }
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      current,
      new Promise<void>((resolve) => {
        deadline = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } finally {
    if (deadline) clearTimeout(deadline);
  }
}
