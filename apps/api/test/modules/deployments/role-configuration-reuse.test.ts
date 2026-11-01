import { describe, it, expect } from "vitest";
import type { Deployment } from "@repo/db";
import type { StackRole } from "@repo/core";
import { reusableRoleReplicas } from "@repo/platform/engine/modules/deployments/role-configuration-rollout";
import { rolloutRoles } from "@repo/platform/engine/modules/deployments/role-rollout";

const worker: StackRole = { name: "queue", kind: "worker", command: "exec worker", replicas: 2 };
const scheduler: StackRole = { name: "scheduler", kind: "scheduler", command: "exec cron" };
const refs = [
  { role: "queue", replica: 1, containerId: "worker1" },
  { role: "queue", replica: 2, containerId: "worker2" },
  { role: "scheduler", replica: 1, containerId: "cron" },
];
const previous = {
  id: "original",
  meta: { roles: [worker, scheduler] },
  roleContainers: refs,
} as Deployment;

describe("configuration revision replica reuse", () => {
  it("preserves stable replica identities through repeated scaling and retains creation ownership", () => {
    const roles = [{ ...worker, replicas: 3 }, scheduler];
    const kept = reusableRoleReplicas(previous, roles);
    expect(kept).toEqual(refs.map((ref) => ({ ...ref, ownerDeploymentId: "original" })));
    const next = {
      ...previous,
      id: "revision",
      meta: { roles },
      roleContainers: kept,
    } as Deployment;
    expect(reusableRoleReplicas(next, [{ ...worker, replicas: 1 }, scheduler])).toEqual([
      kept[0],
      kept[2],
    ]);
    expect(
      reusableRoleReplicas(next, [{ ...worker, replicas: 1, command: "exec changed" }, scheduler]),
    ).toEqual([kept[2]]);
    expect(reusableRoleReplicas(next, [{ ...worker, stopGracePeriod: "60s" }, scheduler])).toEqual([
      kept[2],
    ]);
  });
  it("starts and removes only the changed replicas; abort never destroys retained roles", async () => {
    const roles = [{ ...worker, replicas: 3 }, scheduler];
    const reuse = reusableRoleReplicas(previous, roles);
    const events: string[] = [];
    const deps = {
      roles,
      previousRoles: [worker, scheduler],
      previous: refs,
      reuse,
      startReplica: async (_role: StackRole, replica: number) => {
        events.push(`start ${replica}`);
        return "worker3";
      },
      verify: async () => null,
      stopPrevious: async (id: string) => {
        events.push(`stop ${id}`);
      },
      startPrevious: async (id: string) => {
        events.push(`restore ${id}`);
      },
      destroyPrevious: async (id: string) => {
        events.push(`retire ${id}`);
      },
      destroyStarted: async (id: string) => {
        events.push(`discard ${id}`);
      },
      log: () => {},
    };
    const candidate = await rolloutRoles(deps);
    await candidate.abort();
    expect(events).toEqual(["start 3", "discard worker3"]);
    events.length = 0;
    const downRoles = [{ ...worker, replicas: 1 }, scheduler];
    const down = await rolloutRoles({
      ...deps,
      roles: downRoles,
      reuse: reusableRoleReplicas(previous, downRoles),
    });
    await down.commit();
    expect(events).toEqual(["retire worker2"]);
  });
});
