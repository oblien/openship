import { AppError } from "@repo/core";
import { repos } from "@repo/db";
import { deferBackgroundWork } from "../../lib/background-work";
import { notifyNetworkSetup } from "./network-setup-bus";

type NetworkSetupWorker = { organizationId: string; id: string } & (
  | { kind: "preparation" | "operation"; generation: number }
  | { kind: "verification" }
);

/** Own queued work before yielding; shutdown fences its journal before cancelling host work. */
export function createNetworkSetupLifecycle(dependencies: {
  interrupt(worker: NetworkSetupWorker): Promise<void>;
  defer(work: () => Promise<void>): Promise<unknown>;
}) {
  const workers = new Set<{ worker: NetworkSetupWorker; cancellation: AbortController }>();
  let stopping = false;
  const stopped = () =>
    new AppError(
      "OpenShip is stopping. Reopen the saved setup after restarting.",
      503,
      "NETWORK_SETUP_STOPPING",
    );
  return {
    assertAcceptingWork() {
      if (stopping) throw stopped();
    },
    async defer(worker: NetworkSetupWorker, work: (signal: AbortSignal) => Promise<unknown>) {
      // A request may have claimed its run while shutdown was starting. Persist
      // interruption before that request returns and the HTTP server drains.
      if (stopping) {
        await dependencies.interrupt(worker);
        throw stopped();
      }
      const owned = { worker, cancellation: new AbortController() };
      workers.add(owned);
      void dependencies
        .defer(async () => {
          try {
            if (!owned.cancellation.signal.aborted) await work(owned.cancellation.signal);
          } finally {
            workers.delete(owned);
          }
        })
        .catch((error) => console.warn("[network-setup] background worker stopped:", error));
    },
    async stop() {
      stopping = true;
      const results = await Promise.allSettled(
        [...workers].map(async (owned) => {
          try {
            await dependencies.interrupt(owned.worker);
          } finally {
            // Cancel further orchestration after the durable fence. Commands already
            // running remotely retain their own timeouts and rollback protection.
            owned.cancellation.abort();
          }
        }),
      );
      const failures = results.filter((result) => result.status === "rejected");
      if (failures.length)
        throw new AggregateError(
          failures.map((result) => result.reason),
          "Could not save interrupted network setups",
        );
    },
  };
}

const lifecycle = createNetworkSetupLifecycle({
  defer: deferBackgroundWork,
  async interrupt(worker) {
    if (worker.kind === "preparation") {
      const changed = await repos.networkPreparation.interrupt(
        worker.id,
        worker.generation,
        "OpenShip stopped before server preparation finished. Retry preparation to recheck each server and continue installing missing tools.",
      );
      if (changed.length) notifyNetworkSetup(worker.organizationId, "preparation", worker.id);
    } else if (worker.kind === "operation") {
      const changed = await repos.serverCluster.interruptOperation(
        worker.id,
        worker.generation,
        "OpenShip stopped before network setup finished. Resume or restore this operation to check the host recovery state; host rollback timers run independently.",
      );
      if (changed.length) notifyNetworkSetup(worker.organizationId, "operation", worker.id);
    } else {
      const changed = await repos.serverCluster.interruptVerification(
        worker.id,
        "OpenShip stopped during network verification. Run the checks again.",
      );
      if (changed.length) notifyNetworkSetup(worker.organizationId, "overview");
    }
  },
});

export const assertNetworkSetupAcceptingWork = lifecycle.assertAcceptingWork;
export const deferNetworkSetupWork = lifecycle.defer;
export const stopNetworkSetups = lifecycle.stop;

/** Metadata recovery only. Shared databases retain other controllers' valid leases. */
export async function recoverNetworkSetups(exclusive: boolean): Promise<void> {
  const preparations = await repos.networkPreparation.recoverInterrupted(exclusive);
  for (const row of preparations) notifyNetworkSetup(row.organizationId, "preparation", row.id);
  const { operations, verifications } = await repos.serverCluster.recoverInterrupted(exclusive);
  for (const row of operations) notifyNetworkSetup(row.organizationId, "operation", row.id);
  for (const row of verifications) notifyNetworkSetup(row.organizationId, "overview");
  const count = preparations.length + operations.length + verifications.length;
  if (count) console.log(`[network-setup] marked ${count} abandoned run(s) interrupted`);
}
