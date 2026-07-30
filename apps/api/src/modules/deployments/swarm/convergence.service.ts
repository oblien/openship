/** Bounded, scheduler-aware convergence polling for one Swarm stack apply. */

import {
  deriveSwarmStackHealth,
  type StackRuntimeAdapter,
  type SwarmDiscoverySnapshot,
  type SwarmStackHealth,
} from "@repo/adapters";
import { env } from "../../../config";
import { isConnectionLoss } from "../../../lib/remote-state";

export type SwarmConvergenceStatus = "ready" | "failed" | "timeout" | "unreachable";

export interface SwarmConvergenceResult {
  status: SwarmConvergenceStatus;
  snapshot: SwarmDiscoverySnapshot | null;
  health: SwarmStackHealth | null;
  attempts: number;
}

export interface SwarmConvergenceLogger {
  log(message: string, level?: "info" | "warn" | "error"): void;
}

interface Dependencies {
  now: () => number;
  sleep: (milliseconds: number) => Promise<void>;
  timeoutMs: () => number;
  pollMs: () => number;
}

function health(snapshot: SwarmDiscoverySnapshot, stackName: string): SwarmStackHealth {
  return deriveSwarmStackHealth({
    stackName,
    services: snapshot.services,
    tasks: snapshot.tasks,
    eligibleNodeCount: snapshot.nodes.filter(
      (node) =>
        node.status.toLowerCase() === "ready" && node.availability.toLowerCase() === "active",
    ).length,
  });
}

/** Factory form lets deployment tests advance time without sleeping. */
export function createSwarmConvergenceService(overrides: Partial<Dependencies> = {}) {
  const deps: Dependencies = {
    now: () => Date.now(),
    sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    timeoutMs: () => env.SWARM_CONVERGENCE_TIMEOUT_MS,
    pollMs: () => env.SWARM_CONVERGENCE_POLL_MS,
    ...overrides,
  };

  return {
    async wait(input: {
      runtime: Pick<StackRuntimeAdapter, "discover">;
      stackName: string;
      logger: SwarmConvergenceLogger;
      timeoutMs?: number;
      pollMs?: number;
    }): Promise<SwarmConvergenceResult> {
      const timeoutMs = Math.max(0, input.timeoutMs ?? deps.timeoutMs());
      const pollMs = Math.max(100, input.pollMs ?? deps.pollMs());
      const deadline = deps.now() + timeoutMs;
      let attempts = 0;
      let lastSnapshot: SwarmDiscoverySnapshot | null = null;
      let lastHealth: SwarmStackHealth | null = null;
      let lastState: string | null = null;

      while (true) {
        attempts++;
        try {
          lastSnapshot = await input.runtime.discover();
        } catch (error) {
          if (isConnectionLoss(error)) {
            input.logger.log(
              "Swarm manager became unreachable while convergence was being verified.\n",
              "warn",
            );
            return { status: "unreachable", snapshot: lastSnapshot, health: lastHealth, attempts };
          }
          throw error;
        }
        lastHealth = health(lastSnapshot, input.stackName);
        if (lastHealth.state !== lastState) {
          lastState = lastHealth.state;
          input.logger.log(
            `→ Swarm convergence: ${lastHealth.state} (${lastHealth.services.map((service) => `${service.serviceId}:${service.state}`).join(", ") || "no services reported"}).\n`,
            lastHealth.state === "failed" || lastHealth.state === "partial_failure"
              ? "warn"
              : "info",
          );
        }
        if (lastHealth.state === "ready")
          return { status: "ready", snapshot: lastSnapshot, health: lastHealth, attempts };
        if (lastHealth.state === "failed")
          return { status: "failed", snapshot: lastSnapshot, health: lastHealth, attempts };
        if (deps.now() >= deadline) {
          input.logger.log(
            "Swarm convergence did not settle before the configured timeout; keeping the stack running for reconciliation.\n",
            "warn",
          );
          return { status: "timeout", snapshot: lastSnapshot, health: lastHealth, attempts };
        }
        await deps.sleep(Math.min(pollMs, Math.max(0, deadline - deps.now())));
      }
    },
  };
}

export const swarmConvergence = createSwarmConvergenceService();
