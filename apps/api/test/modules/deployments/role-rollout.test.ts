import { describe, it, expect } from "vitest";
import type { StackRole } from "@repo/core";
import {
  isSingletonRole,
  planRoleReplicas,
  rolloutRoles,
  type RoleContainerRef,
  type RoleRolloutDeps,
} from "@repo/platform/engine/modules/deployments/role-rollout";
import { DeploymentCancelledError } from "@repo/platform/engine/modules/deployments/deployment-cancellation";

/**
 * The role rollout decides ORDER: scalable replicas start beside the old ones and
 * are checked first, singletons hand over stop-first with the old one retained,
 * and any failure destroys what was started before restarting what was retained.
 * Every side effect is appended to one shared `events` list so each order
 * assertion is exact.
 */

const worker = (replicas?: number, name = "worker"): StackRole => ({
  name,
  kind: "worker",
  command: `run ${name}`,
  ...(replicas === undefined ? {} : { replicas }),
});
const scheduler = (name = "sched", replicas?: number): StackRole => ({
  name,
  kind: "scheduler",
  command: `run ${name}`,
  ...(replicas === undefined ? {} : { replicas }),
});

const ref = (role: string, replica: number, containerId: string): RoleContainerRef => ({
  role,
  replica,
  containerId,
});

interface Harness {
  deps: RoleRolloutDeps;
  events: string[];
  warnings: string[];
}

function harness(overrides: Partial<RoleRolloutDeps> = {}): Harness {
  const events: string[] = [];
  const warnings: string[] = [];
  const deps: RoleRolloutDeps = {
    roles: [],
    previous: [],
    startReplica: async (role, replica) => {
      events.push(`start ${role.name} ${replica}`);
      return `new-${role.name}-${replica}`;
    },
    verify: async (containers) => {
      events.push(`verify ${containers.map((c) => `${c.role}-${c.replica}`).join(",")}`);
      return null;
    },
    stopPrevious: async (id) => {
      events.push(`stopPrev ${id}`);
    },
    startPrevious: async (id) => {
      events.push(`startPrev ${id}`);
    },
    destroyPrevious: async (id) => {
      events.push(`destroyPrev ${id}`);
    },
    destroyStarted: async (id) => {
      events.push(`destroyNew ${id}`);
    },
    log: (message, level) => {
      if (level === "warn") warnings.push(message);
    },
    ...overrides,
  };
  return { deps, events, warnings };
}

const never = () => new Promise<void>(() => {});

/** Teardown is concurrent, so call order among destroys is not an order guarantee; the sorted set is. */
const calls = (events: string[], prefix: string) =>
  events.filter((e) => e.startsWith(prefix)).sort();

/** Every removal is attempted before restoration; state assertions cover failed removals below. */
function expectDestroysBeforeRestarts(events: string[]) {
  const lastDestroy = events.map((e) => e.startsWith("destroyNew")).lastIndexOf(true);
  const firstRestart = events.findIndex((e) => e.startsWith("startPrev"));
  if (firstRestart !== -1) expect(lastDestroy).toBeLessThan(firstRestart);
}

/** A promise the test settles by hand. */
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

/** Let every queued microtask run. */
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("durable role registration", () => {
  it("removes a created container even when its durable reference write fails", async () => {
    const { deps, events } = harness({
      roles: [worker()],
      startReplica: async (_role, _replica, created) => {
        await created!("created-before-write");
        events.push("process started");
        return "created-before-write";
      },
      recordCreated: async () => {
        throw new Error("storage unavailable");
      },
    });
    await expect(rolloutRoles(deps)).rejects.toThrow("storage unavailable");
    expect(events).toEqual(["destroyNew created-before-write"]);
  });

  it("does not stop a previous singleton if stop intent cannot be persisted", async () => {
    const { deps, events } = harness({
      roles: [scheduler()],
      previous: [ref("sched", 1, "previous")],
      recordStopIntent: async () => {
        throw new Error("storage unavailable");
      },
    });
    await expect(rolloutRoles(deps)).rejects.toThrow("storage unavailable");
    expect(events).toEqual([]);
  });
});

describe("isSingletonRole", () => {
  it("is true for a scheduler or an explicit singleton, false otherwise", () => {
    expect(isSingletonRole({ kind: "scheduler" })).toBe(true);
    expect(isSingletonRole({ kind: "worker", singleton: true })).toBe(true);
    expect(isSingletonRole({ kind: "worker" })).toBe(false);
    expect(isSingletonRole({ kind: "worker", singleton: false })).toBe(false);
  });
});

describe("planRoleReplicas", () => {
  it("gives a scheduler exactly one replica, with or without `replicas`", () => {
    const plan = planRoleReplicas([scheduler("a"), scheduler("b", 4)]);
    expect(plan.scalable).toEqual([]);
    expect(plan.singletons.map((s) => [s.role.name, s.replica])).toEqual([
      ["a", 1],
      ["b", 1],
    ]);
  });

  it("gives `singleton: true` exactly one replica", () => {
    const role: StackRole = {
      name: "leader",
      kind: "worker",
      command: "x",
      singleton: true,
      replicas: 3,
    };
    const plan = planRoleReplicas([role]);
    expect(plan.scalable).toEqual([]);
    expect(plan.singletons).toEqual([{ role, replica: 1 }]);
  });

  it("numbers a scalable role's replicas from 1", () => {
    const plan = planRoleReplicas([worker(3)]);
    expect(plan.scalable.map((s) => s.replica)).toEqual([1, 2, 3]);
    expect(plan.singletons).toEqual([]);
  });

  it("defaults a scalable role to one replica", () => {
    expect(planRoleReplicas([worker()]).scalable.map((s) => s.replica)).toEqual([1]);
  });

  it("is empty for null, undefined and []", () => {
    for (const roles of [null, undefined, []]) {
      expect(planRoleReplicas(roles)).toEqual({ scalable: [], singletons: [] });
    }
  });

  it("keeps declared order within each group", () => {
    const plan = planRoleReplicas([
      worker(2, "b"),
      scheduler("s1"),
      worker(1, "a"),
      scheduler("s2"),
    ]);
    expect(plan.scalable.map((s) => `${s.role.name}${s.replica}`)).toEqual(["b1", "b2", "a1"]);
    expect(plan.singletons.map((s) => s.role.name)).toEqual(["s1", "s2"]);
  });
});

describe("rolloutRoles: nothing to do", () => {
  it("calls no dependency when there are no roles and no previous containers", async () => {
    const { deps, events, warnings } = harness({ roles: [], previous: [] });
    const rollout = await rolloutRoles(deps);
    expect(rollout.started).toEqual([]);
    expect(await rollout.commit()).toBeNull();
    await rollout.abort();
    expect(events).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it("treats null roles and null previous as empty", async () => {
    const { deps, events } = harness({ roles: null, previous: null });
    const rollout = await rolloutRoles(deps);
    await rollout.commit();
    expect(events).toEqual([]);
  });

  it("with no roles but previous containers, starts and stops nothing; commit destroys them all", async () => {
    const previous = [ref("worker", 1, "old-w1"), ref("sched", 1, "old-sched")];
    const { deps, events } = harness({ roles: [], previous });
    const rollout = await rolloutRoles(deps);
    expect(rollout.started).toEqual([]);
    expect(events).toEqual([]);
    expect(await rollout.commit()).toBeNull();
    expect(events).toEqual(["destroyPrev old-w1", "destroyPrev old-sched"]);
  });

  it("with no roles but previous containers, abort touches nothing", async () => {
    const previous = [ref("worker", 1, "old-w1")];
    const { deps, events } = harness({ roles: [], previous });
    const rollout = await rolloutRoles(deps);
    await rollout.abort();
    expect(events).toEqual([]);
  });
});

describe("rolloutRoles: scalable roles only", () => {
  it("starts in order, verifies once with exactly those refs, and leaves previous alone until commit", async () => {
    const previous = [ref("worker", 1, "old-w1"), ref("worker", 2, "old-w2")];
    const { deps, events } = harness({ roles: [worker(2), worker(1, "mail")], previous });
    const rollout = await rolloutRoles(deps);

    expect(events).toEqual([
      "start worker 1",
      "start worker 2",
      "start mail 1",
      "verify worker-1,worker-2,mail-1",
    ]);
    expect(rollout.started).toEqual([
      ref("worker", 1, "new-worker-1"),
      ref("worker", 2, "new-worker-2"),
      ref("mail", 1, "new-mail-1"),
    ]);

    events.length = 0;
    await rollout.commit();
    expect(events).toEqual(["destroyPrev old-w1", "destroyPrev old-w2"]);
  });
});

describe("rolloutRoles: scalable and singleton together", () => {
  it("runs scalable start, scalable verify, singleton stop, singleton start, singleton verify", async () => {
    const previous = [
      ref("worker", 1, "old-w1"),
      ref("sched", 1, "old-sched"),
      ref("billing", 1, "old-billing"),
    ];
    const { deps, events } = harness({
      roles: [scheduler("sched"), worker(2)],
      previous,
    });
    const rollout = await rolloutRoles(deps);

    expect(events).toEqual([
      "start worker 1",
      "start worker 2",
      "verify worker-1,worker-2",
      "stopPrev old-sched",
      "start sched 1",
      "verify sched-1",
    ]);
    // Neither the other role's singleton nor the overlapped worker was stopped.
    expect(events).not.toContain("stopPrev old-billing");
    expect(events).not.toContain("stopPrev old-w1");

    events.length = 0;
    await rollout.commit();
    // Commit retires every previous container, including a role no longer declared.
    expect(events).toEqual([
      "destroyPrev old-w1",
      "destroyPrev old-sched",
      "destroyPrev old-billing",
    ]);
  });

  it("stops every previous container of the singleton's name, one at a time", async () => {
    const previous = [ref("sched", 1, "old-a"), ref("other", 1, "old-x"), ref("sched", 2, "old-b")];
    const { deps, events } = harness({ roles: [scheduler("sched")], previous });
    await rolloutRoles(deps);
    expect(events).toEqual(["stopPrev old-a", "stopPrev old-b", "start sched 1", "verify sched-1"]);
  });

  it("starts a singleton with no previous container without stopping anything", async () => {
    const { deps, events } = harness({ roles: [scheduler("sched")], previous: [] });
    await rolloutRoles(deps);
    expect(events).toEqual(["start sched 1", "verify sched-1"]);
  });
});

describe("rolloutRoles: a singleton that changes name or kind (#1253)", () => {
  // The previous deployment's frozen roles tell a renamed scheduler apart from a worker.
  const prevRoles = [worker(1, "queue"), scheduler("scheduler")];
  const prevRefs = [ref("queue", 1, "old-queue"), ref("scheduler", 1, "old-sched")];

  it("stops a renamed scheduler before its replacement starts, after the unchanged worker is checked", async () => {
    const { deps, events } = harness({
      roles: [worker(1, "queue"), scheduler("cron")],
      previousRoles: prevRoles,
      previous: prevRefs,
    });
    const rollout = await rolloutRoles(deps);
    expect(events).toEqual([
      "start queue 1",
      "verify queue-1",
      "stopPrev old-sched",
      "start cron 1",
      "verify cron-1",
    ]);
    events.length = 0;
    await rollout.commit();
    expect(events).toEqual(["destroyPrev old-queue", "destroyPrev old-sched"]);
  });

  it.each([
    [
      "keeps its name",
      worker(2, "scheduler"),
      ["start scheduler 1", "start scheduler 2", "verify scheduler-1,scheduler-2"],
    ],
    ["is renamed", worker(1, "cron"), ["start cron 1", "verify cron-1"]],
  ] as const)(
    "stops a scheduler that becomes a worker and %s before any replica of it starts",
    async (_label, changed, changedEvents) => {
      const { deps, events } = harness({
        roles: [worker(1, "queue"), changed],
        previousRoles: prevRoles,
        previous: prevRefs,
      });
      await rolloutRoles(deps);
      expect(events).toEqual([
        "start queue 1",
        "verify queue-1",
        "stopPrev old-sched",
        ...changedEvents,
      ]);
    },
  );

  it("leaves a removed scheduler running until commit when nothing could replace it", async () => {
    const { deps, events } = harness({
      roles: [worker(1, "queue")],
      previousRoles: prevRoles,
      previous: prevRefs,
    });
    const rollout = await rolloutRoles(deps);
    expect(events).toEqual(["start queue 1", "verify queue-1"]);
    events.length = 0;
    await rollout.commit();
    expect(events).toEqual(["destroyPrev old-queue", "destroyPrev old-sched"]);
  });

  it("keeps the same-name handover when the previous definitions are unknown", async () => {
    const { deps, events } = harness({
      roles: [worker(1, "queue"), scheduler("cron")],
      previous: prevRefs,
    });
    await rolloutRoles(deps);
    expect(events).toEqual(["start queue 1", "verify queue-1", "start cron 1", "verify cron-1"]);
  });

  it("sees a cancellation before it stops the renamed scheduler", async () => {
    const controller = new AbortController();
    const { deps, events } = harness({
      roles: [worker(1, "queue"), scheduler("cron")],
      previousRoles: prevRoles,
      previous: prevRefs,
      signal: controller.signal,
      keepProvisionedOnCancel: true,
      verify: async (containers) => {
        events.push(`verify ${containers.map((c) => `${c.role}-${c.replica}`).join(",")}`);
        controller.abort();
        return null;
      },
    });
    await expect(rolloutRoles(deps)).rejects.toBeInstanceOf(DeploymentCancelledError);
    expect(events).toEqual(["start queue 1", "verify queue-1"]);
  });

  it.each([
    ["is removed", null, ["startPrev old-sched"]],
    ["cannot be removed", "new-cron-1", []],
    ["is fine but the unchanged worker cannot be removed", "new-queue-1", ["startPrev old-sched"]],
  ] as const)(
    "after a failed start, restores the renamed scheduler only when its replacement %s",
    async (_label, failedRemoval, restarts) => {
      const { deps, events, warnings } = harness({
        roles: [worker(1, "queue"), scheduler("cron")],
        previousRoles: prevRoles,
        previous: prevRefs,
        verify: async (containers) => {
          events.push(`verify ${containers.map((c) => `${c.role}-${c.replica}`).join(",")}`);
          return containers.some((c) => c.role === "cron") ? "cron crashed" : null;
        },
        destroyStarted: async (id) => {
          events.push(`destroyNew ${id}`);
          if (id === failedRemoval) throw new Error("removal failed");
        },
      });
      await expect(rolloutRoles(deps)).rejects.toThrow("cron crashed");
      expect(calls(events, "destroyNew")).toEqual([
        "destroyNew new-cron-1",
        "destroyNew new-queue-1",
      ]);
      expect(calls(events, "startPrev")).toEqual(restarts);
      expectDestroysBeforeRestarts(events);
      const incomplete = warnings.find((w) => w.includes("Rollback incomplete"));
      if (failedRemoval === "new-cron-1") {
        expect(incomplete).toContain("old-sched");
        expect(incomplete).toContain("new-cron-1");
      } else {
        expect(incomplete).toBeUndefined();
      }
    },
  );

  it("fails the rollout when the renamed scheduler cannot be stopped, and never starts its replacement", async () => {
    const { deps, events } = harness({
      roles: [worker(1, "queue"), scheduler("cron")],
      previousRoles: prevRoles,
      previous: prevRefs,
      stopPrevious: async (id) => {
        events.push(`stopPrev ${id}`);
        throw new Error("stop failed");
      },
    });
    await expect(rolloutRoles(deps)).rejects.toThrow(
      'Could not stop the previous "scheduler" container, so a single instance cannot be guaranteed: stop failed',
    );
    expect(events).not.toContain("start cron 1");
    expect(calls(events, "destroyNew")).toEqual(["destroyNew new-queue-1"]);
    expect(calls(events, "startPrev")).toEqual([]);
  });
});

describe("rolloutRoles: a role continues only when it runs the same workload (#1253)", () => {
  /** The same role definition, now running another command. */
  const running = (role: StackRole, command: string): StackRole => ({ ...role, command });

  describe("two singletons swap their names", () => {
    // Old a runs A and old b runs B. New a runs B and new b runs A.
    const prevRoles = [scheduler("a"), scheduler("b")];
    const roles = [running(scheduler("a"), "run b"), running(scheduler("b"), "run a")];
    const previous = [ref("a", 1, "old-a"), ref("b", 1, "old-b")];

    it("stops both previous singletons before either new one starts", async () => {
      const { deps, events } = harness({ roles, previousRoles: prevRoles, previous });
      await rolloutRoles(deps);
      expect(events).toEqual([
        "stopPrev old-a",
        "stopPrev old-b",
        "start a 1",
        "start b 1",
        "verify a-1,b-1",
      ]);
    });

    it.each([
      [null, ["startPrev old-a", "startPrev old-b"]],
      ["new-a-1", []],
      ["new-b-1", []],
    ] as const)(
      "on abort with removal of %s failing, restores the previous singletons only when both replacements are gone",
      async (failedRemoval, restarts) => {
        const { deps, events, warnings } = harness({
          roles,
          previousRoles: prevRoles,
          previous,
          destroyStarted: async (id) => {
            events.push(`destroyNew ${id}`);
            if (id === failedRemoval) throw new Error("removal failed");
          },
        });
        const rollout = await rolloutRoles(deps);
        events.length = 0;
        await rollout.abort();
        expect(calls(events, "destroyNew")).toEqual(["destroyNew new-a-1", "destroyNew new-b-1"]);
        expect(calls(events, "startPrev")).toEqual(restarts);
        expectDestroysBeforeRestarts(events);
        if (failedRemoval) {
          const incomplete = warnings.filter((w) => w.includes("Rollback incomplete"));
          expect(incomplete).toHaveLength(2);
          for (const warning of incomplete) expect(warning).toContain(failedRemoval);
        }
      },
    );
  });

  describe("a scheduler's workload moves into an existing worker name", () => {
    // Old scheduler runs A and old queue runs B. New queue runs A, with two replicas.
    const prevRoles = [scheduler("scheduler"), worker(1, "queue")];
    const roles = [running(worker(2, "queue"), "run scheduler")];
    const previous = [ref("queue", 1, "old-queue"), ref("scheduler", 1, "old-sched")];

    it("stops the previous scheduler before any queue replica starts", async () => {
      const { deps, events } = harness({ roles, previousRoles: prevRoles, previous });
      const rollout = await rolloutRoles(deps);
      expect(events).toEqual([
        "stopPrev old-sched",
        "start queue 1",
        "start queue 2",
        "verify queue-1,queue-2",
      ]);
      events.length = 0;
      await rollout.commit();
      expect(events).toEqual(["destroyPrev old-queue", "destroyPrev old-sched"]);
    });

    it.each([
      [null, ["startPrev old-sched"]],
      ["new-queue-2", []],
    ] as const)(
      "on abort with removal of %s failing, restores the previous scheduler only when every queue replica is gone",
      async (failedRemoval, restarts) => {
        const { deps, events, warnings } = harness({
          roles,
          previousRoles: prevRoles,
          previous,
          destroyStarted: async (id) => {
            events.push(`destroyNew ${id}`);
            if (id === failedRemoval) throw new Error("removal failed");
          },
        });
        const rollout = await rolloutRoles(deps);
        events.length = 0;
        await rollout.abort();
        expect(calls(events, "startPrev")).toEqual(restarts);
        expectDestroysBeforeRestarts(events);
        const incomplete = warnings.find((w) => w.includes("Rollback incomplete"));
        if (failedRemoval) expect(incomplete).toContain(failedRemoval);
        else expect(incomplete).toBeUndefined();
      },
    );
  });

  it("treats a same-name singleton with an edited command as a replacement, not a continuation", async () => {
    const { deps, events } = harness({
      roles: [worker(1, "queue"), running(scheduler("scheduler"), "run scheduler --verbose")],
      previousRoles: [worker(1, "queue"), scheduler("scheduler")],
      previous: [ref("queue", 1, "old-queue"), ref("scheduler", 1, "old-sched")],
    });
    await rolloutRoles(deps);
    // Stopped once, as an outgoing singleton, before the changed scheduler starts.
    expect(events).toEqual([
      "start queue 1",
      "verify queue-1",
      "stopPrev old-sched",
      "start scheduler 1",
      "verify scheduler-1",
    ]);
  });
});

describe("rolloutRoles: failures unwind before rethrowing", () => {
  it("scalable verify failure: destroys every started container, never stops a singleton, message has the detail", async () => {
    const { deps, events } = harness({
      roles: [worker(2), scheduler("sched")],
      previous: [ref("sched", 1, "old-sched")],
      verify: async (containers) => {
        events.push(`verify ${containers.map((c) => `${c.role}-${c.replica}`).join(",")}`);
        return "worker-2 exited with code 1";
      },
    });
    const error = await rolloutRoles(deps).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("worker-2 exited with code 1");
    expect((error as Error).message).toBe("Role startup check failed: worker-2 exited with code 1");
    expect(events).toEqual([
      "start worker 1",
      "start worker 2",
      "verify worker-1,worker-2",
      "destroyNew new-worker-1",
      "destroyNew new-worker-2",
    ]);
    expect(events.some((e) => e.startsWith("stopPrev"))).toBe(false);
    expect(events.some((e) => e.startsWith("startPrev"))).toBe(false);
  });

  it("singleton verify failure: destroys all started (new singleton included), THEN restarts the retained one", async () => {
    let call = 0;
    const { deps, events } = harness({
      roles: [worker(1), scheduler("sched")],
      previous: [ref("sched", 1, "old-sched"), ref("worker", 1, "old-w1")],
      verify: async (containers) => {
        events.push(`verify ${containers.map((c) => `${c.role}-${c.replica}`).join(",")}`);
        return ++call === 2 ? "sched keeps crashing" : null;
      },
    });
    await expect(rolloutRoles(deps)).rejects.toThrow(
      "Role startup check failed: sched keeps crashing",
    );
    expect(events).toEqual([
      "start worker 1",
      "verify worker-1",
      "stopPrev old-sched",
      "start sched 1",
      "verify sched-1",
      "destroyNew new-worker-1",
      "destroyNew new-sched-1",
      "startPrev old-sched",
    ]);
    expectDestroysBeforeRestarts(events);
    // The overlapped worker was never stopped, so it is never restarted either.
    expect(events).not.toContain("startPrev old-w1");
  });

  it("a startReplica rejection destroys the replicas already started and rethrows the SAME error object", async () => {
    const boom = new Error("image pull failed");
    const events: string[] = [];
    const { deps } = harness({
      roles: [worker(3)],
      startReplica: async (role, replica) => {
        events.push(`start ${role.name} ${replica}`);
        if (replica === 3) throw boom;
        return `new-${role.name}-${replica}`;
      },
      destroyStarted: async (id) => {
        events.push(`destroyNew ${id}`);
      },
    });
    const error = await rolloutRoles(deps).catch((e: unknown) => e);
    expect(error).toBe(boom);
    expect(events).toEqual([
      "start worker 1",
      "start worker 2",
      "start worker 3",
      "destroyNew new-worker-1",
      "destroyNew new-worker-2",
    ]);
  });

  it("a stopPrevious rejection never starts the singleton, destroys started replicas, restarts nothing, and names the role", async () => {
    const { deps, events } = harness({
      roles: [worker(1), scheduler("sched")],
      previous: [ref("sched", 1, "old-sched")],
      stopPrevious: async (id) => {
        events.push(`stopPrev ${id}`);
        throw new Error("docker daemon unreachable");
      },
    });
    const error = await rolloutRoles(deps).catch((e: unknown) => e);
    expect((error as Error).message).toContain("sched");
    expect((error as Error).message).toContain("docker daemon unreachable");
    expect(events).toEqual([
      "start worker 1",
      "verify worker-1",
      "stopPrev old-sched",
      "destroyNew new-worker-1",
    ]);
    expect(events).not.toContain("start sched 1");
    expect(events.some((e) => e.startsWith("startPrev"))).toBe(false);
  });

  it("restarts only the containers whose stop resolved when a later stop fails", async () => {
    const { deps, events } = harness({
      roles: [scheduler("sched")],
      previous: [ref("sched", 1, "old-a"), ref("sched", 2, "old-b")],
      stopPrevious: async (id) => {
        events.push(`stopPrev ${id}`);
        if (id === "old-b") throw new Error("stuck");
      },
    });
    await expect(rolloutRoles(deps)).rejects.toThrow(/sched/);
    expect(events).toEqual(["stopPrev old-a", "stopPrev old-b", "startPrev old-a"]);
  });

  it("treats a stopPrevious that never settles as a failure and does not retain it", async () => {
    const { deps, events } = harness({
      roles: [scheduler("sched")],
      previous: [ref("sched", 1, "old-sched")],
      teardownTimeoutMs: 20,
      stopPrevious: async (id) => {
        events.push(`stopPrev ${id}`);
        await never();
      },
    });
    const error = await rolloutRoles(deps).catch((e: unknown) => e);
    expect((error as Error).message).toContain("sched");
    expect((error as Error).message).toContain("timed out after 20ms");
    expect(events).toEqual(["stopPrev old-sched"]);
    expect(events).not.toContain("start sched 1");
    expect(events).not.toContain("startPrev old-sched");
  });

  it("treats verify throwing as a failure and unwinds", async () => {
    const boom = new Error("inspect blew up");
    const { deps, events } = harness({
      roles: [worker(1)],
      verify: async () => {
        throw boom;
      },
    });
    await expect(rolloutRoles(deps)).rejects.toBe(boom);
    expect(events).toEqual(["start worker 1", "destroyNew new-worker-1"]);
  });
});

describe("rolloutRoles: cancellation", () => {
  it("an aborted signal before a start throws DeploymentCancelledError and unwinds what was started", async () => {
    const controller = new AbortController();
    const { deps, events } = harness({
      roles: [worker(2)],
      signal: controller.signal,
      startReplica: async (role, replica) => {
        events.push(`start ${role.name} ${replica}`);
        controller.abort();
        return `new-${role.name}-${replica}`;
      },
    });
    await expect(rolloutRoles(deps)).rejects.toBeInstanceOf(DeploymentCancelledError);
    expect(events).toEqual(["start worker 1", "destroyNew new-worker-1"]);
  });

  it("an already aborted signal starts nothing", async () => {
    const controller = new AbortController();
    controller.abort();
    const { deps, events } = harness({ roles: [worker(1)], signal: controller.signal });
    await expect(rolloutRoles(deps)).rejects.toBeInstanceOf(DeploymentCancelledError);
    expect(events).toEqual([]);
  });

  it("cancelled before the singleton starts restarts the retained singleton after destroying started", async () => {
    const controller = new AbortController();
    const { deps, events } = harness({
      roles: [scheduler("sched")],
      previous: [ref("sched", 1, "old-sched")],
      signal: controller.signal,
      stopPrevious: async (id) => {
        events.push(`stopPrev ${id}`);
        controller.abort();
      },
    });
    await expect(rolloutRoles(deps)).rejects.toBeInstanceOf(DeploymentCancelledError);
    expect(events).toEqual(["stopPrev old-sched", "startPrev old-sched"]);
  });

  it("keepProvisionedOnCancel leaves every container as it is: no destroy, no restart", async () => {
    const controller = new AbortController();
    const { deps, events } = harness({
      roles: [worker(1), scheduler("sched")],
      previous: [ref("sched", 1, "old-sched")],
      signal: controller.signal,
      keepProvisionedOnCancel: true,
      stopPrevious: async (id) => {
        events.push(`stopPrev ${id}`);
        controller.abort();
      },
    });
    await expect(rolloutRoles(deps)).rejects.toBeInstanceOf(DeploymentCancelledError);
    expect(events).toEqual(["start worker 1", "verify worker-1", "stopPrev old-sched"]);
  });

  it("a cancellation during the scalable verify is seen before the old singleton is stopped", async () => {
    const controller = new AbortController();
    const { deps, events } = harness({
      roles: [worker(1), scheduler("sched")],
      previous: [ref("sched", 1, "old-sched")],
      signal: controller.signal,
      keepProvisionedOnCancel: true,
      verify: async (containers) => {
        events.push(`verify ${containers.map((c) => `${c.role}-${c.replica}`).join(",")}`);
        controller.abort();
        return null;
      },
    });
    await expect(rolloutRoles(deps)).rejects.toBeInstanceOf(DeploymentCancelledError);
    expect(events).toEqual(["start worker 1", "verify worker-1"]);
    expect(events).not.toContain("stopPrev old-sched");
  });

  it("a cancellation during the singleton verify unwinds instead of reporting success", async () => {
    const controller = new AbortController();
    const { deps, events } = harness({
      roles: [scheduler("sched")],
      previous: [ref("sched", 1, "old-sched")],
      signal: controller.signal,
      verify: async (containers) => {
        events.push(`verify ${containers.map((c) => `${c.role}-${c.replica}`).join(",")}`);
        controller.abort();
        return null;
      },
    });
    await expect(rolloutRoles(deps)).rejects.toBeInstanceOf(DeploymentCancelledError);
    expect(events).toEqual([
      "stopPrev old-sched",
      "start sched 1",
      "verify sched-1",
      "destroyNew new-sched-1",
      "startPrev old-sched",
    ]);
  });

  it("keepProvisionedOnCancel does not suppress the unwind for an ordinary failure", async () => {
    const { deps, events } = harness({
      roles: [worker(1)],
      keepProvisionedOnCancel: true,
      verify: async () => "crashed",
    });
    await expect(rolloutRoles(deps)).rejects.toThrow("crashed");
    expect(events).toEqual(["start worker 1", "destroyNew new-worker-1"]);
  });
});

describe("rolloutRoles: best-effort teardown", () => {
  it("unwind: a destroy that rejects or hangs warns and the rest still run, and the original error is rethrown", async () => {
    const events: string[] = [];
    const { deps, warnings } = harness({
      roles: [worker(3), scheduler("sched")],
      previous: [ref("sched", 1, "old-sched")],
      teardownTimeoutMs: 20,
      verify: async (containers) => (containers[0]?.role === "sched" ? "sched down" : null),
      destroyStarted: async (id) => {
        events.push(`destroyNew ${id}`);
        if (id === "new-sched-1") throw new Error("rm failed");
        if (id === "new-worker-3") await never();
      },
      startPrevious: async (id) => {
        events.push(`startPrev ${id}`);
      },
    });
    await expect(rolloutRoles(deps)).rejects.toThrow("Role startup check failed: sched down");
    expect(calls(events, "destroyNew")).toEqual([
      "destroyNew new-sched-1",
      "destroyNew new-worker-1",
      "destroyNew new-worker-2",
      "destroyNew new-worker-3",
    ]);
    expect(calls(events, "startPrev")).toEqual([]);
    expectDestroysBeforeRestarts(events);
    expect(warnings).toHaveLength(3);
    expect(warnings.some((w) => w.includes("rm failed"))).toBe(true);
    expect(warnings.some((w) => w.includes("timed out after 20ms"))).toBe(true);
    expect(warnings.some((w) => w.includes("Rollback incomplete"))).toBe(true);
  });

  it("unwind: a failed restart of a retained container warns and continues", async () => {
    const events: string[] = [];
    const { deps, warnings } = harness({
      roles: [scheduler("sched")],
      previous: [ref("sched", 1, "old-a"), ref("sched", 2, "old-b")],
      verify: async () => "down",
      startPrevious: async (id) => {
        events.push(`startPrev ${id}`);
        if (id === "old-a") throw new Error("start failed");
      },
    });
    await expect(rolloutRoles(deps)).rejects.toThrow("down");
    expect(events).toEqual(["startPrev old-a", "startPrev old-b"]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("start failed");
  });

  it("commit: a destroyPrevious that rejects or hangs warns, the rest still run, and commit does not throw", async () => {
    const events: string[] = [];
    const { deps, warnings } = harness({
      roles: [worker(1)],
      previous: [ref("worker", 1, "old-1"), ref("worker", 2, "old-2"), ref("worker", 3, "old-3")],
      teardownTimeoutMs: 20,
      destroyPrevious: async (id) => {
        events.push(`destroyPrev ${id}`);
        if (id === "old-1") throw new Error("rm failed");
        if (id === "old-2") await never();
      },
    });
    const rollout = await rolloutRoles(deps);
    // Resolves (never throws) to the deploy's warning, naming only the failed removals.
    await expect(rollout.commit()).resolves.toBe(
      "2 previous role containers could not be removed: worker replica 1 (old-1), worker replica 2 (old-2). " +
        "They may still be running the previous release's code. Remove them manually.",
    );
    expect(events).toEqual(["destroyPrev old-1", "destroyPrev old-2", "destroyPrev old-3"]);
    expect(warnings).toHaveLength(2);
    expect(warnings.some((w) => w.includes("rm failed"))).toBe(true);
    expect(warnings.some((w) => w.includes("timed out after 20ms"))).toBe(true);
  });

  it("commit: names a single failed removal by role, replica and short container id", async () => {
    const id = `0123456789ab${"c".repeat(52)}`;
    const { deps } = harness({
      roles: [scheduler("cron")],
      previous: [ref("scheduler", 1, id)],
      destroyPrevious: async () => {
        throw new Error("rm failed");
      },
    });
    const rollout = await rolloutRoles(deps);
    expect(await rollout.commit()).toBe(
      "Previous role container scheduler replica 1 (0123456789ab) could not be removed. " +
        "It may still be running the previous release's code. Remove it manually.",
    );
    expect(await rollout.commit()).toBeNull();
  });

  it("abort after success: attempts every removal and keeps a previous singleton stopped if its replacement survives", async () => {
    const { deps, events, warnings } = harness({
      roles: [worker(2), scheduler("sched")],
      previous: [ref("sched", 1, "old-sched")],
      destroyStarted: async (id) => {
        events.push(`destroyNew ${id}`);
        if (id === "new-sched-1") throw new Error("rm failed");
      },
    });
    const rollout = await rolloutRoles(deps);
    events.length = 0;
    await expect(rollout.abort()).resolves.toBeUndefined();
    expect(calls(events, "destroyNew")).toEqual([
      "destroyNew new-sched-1",
      "destroyNew new-worker-1",
      "destroyNew new-worker-2",
    ]);
    expect(calls(events, "startPrev")).toEqual([]);
    expectDestroysBeforeRestarts(events);
    expect(warnings).toHaveLength(2);
    expect(warnings[1]).toContain("old-sched");
    expect(warnings[1]).toContain("new-sched-1");
  });
});

describe("rolloutRoles: uncertain replacement removal", () => {
  it.each([
    ["abort", "reject"],
    ["abort", "timeout"],
    ["startup failure", "reject"],
    ["startup failure", "timeout"],
  ] as const)(
    "preserves singleton exclusivity on %s when removal ends in %s",
    async (outcome, failure) => {
      const running = new Set(["old-sched"]);
      const cleanup = gate();
      let pendingCleanup: Promise<void> | undefined;
      const { deps, warnings } = harness({
        roles: [scheduler()],
        previous: [ref("sched", 1, "old-sched")],
        teardownTimeoutMs: 20,
        stopPrevious: async (id) => {
          running.delete(id);
        },
        startReplica: async () => {
          running.add("new-sched");
          return "new-sched";
        },
        verify: async () => (outcome === "startup failure" ? "health command failed" : null),
        destroyStarted: (id) => {
          if (failure === "reject") return Promise.reject(new Error("removal failed"));
          pendingCleanup = cleanup.promise.then(() => {
            running.delete(id);
          });
          return pendingCleanup;
        },
        startPrevious: async (id) => {
          running.add(id);
        },
      });
      try {
        if (outcome === "abort") {
          const rollout = await rolloutRoles(deps);
          expect([...running]).toEqual(["new-sched"]);
          await rollout.abort();
          await rollout.abort();
          await rollout.commit();
        } else {
          await expect(rolloutRoles(deps)).rejects.toThrow("health command failed");
        }
        expect([...running]).toEqual(["new-sched"]);
        const recoveryWarning = warnings.find((warning) => warning.includes("Rollback incomplete"));
        expect(recoveryWarning).toContain("old-sched");
        expect(recoveryWarning).toContain("new-sched");
        expect(recoveryWarning).toContain("before restarting");
      } finally {
        cleanup.release();
        await pendingCleanup;
      }
      // A timeout does not cancel removal. Its eventual completion must not
      // trigger a delayed restart after the deployment has already failed.
      expect([...running]).toEqual(failure === "timeout" ? [] : ["new-sched"]);
    },
  );

  it.each(["worker", "sched-a"])(
    "restores independent singletons when removing %s fails",
    async (failedRole) => {
      const { deps, events } = harness({
        roles: [worker(), scheduler("sched-a"), scheduler("sched-b")],
        previous: [ref("sched-a", 1, "old-a"), ref("sched-b", 1, "old-b")],
        destroyStarted: async (id) => {
          events.push(`destroyNew ${id}`);
          if (id === `new-${failedRole}-1`) throw new Error("removal failed");
        },
      });
      const rollout = await rolloutRoles(deps);
      events.length = 0;
      await rollout.abort();
      expect(calls(events, "destroyNew")).toHaveLength(3);
      expect(calls(events, "startPrev")).toEqual(
        failedRole === "worker" ? ["startPrev old-a", "startPrev old-b"] : ["startPrev old-b"],
      );
      expectDestroysBeforeRestarts(events);
    },
  );
});

describe("rolloutRoles: commit and abort are idempotent and mutually exclusive", () => {
  const setup = async () => {
    const h = harness({
      roles: [worker(1)],
      previous: [ref("worker", 1, "old-w1")],
    });
    const rollout = await rolloutRoles(h.deps);
    h.events.length = 0;
    return { ...h, rollout };
  };

  it("commit twice destroys once", async () => {
    const { rollout, events } = await setup();
    await rollout.commit();
    await rollout.commit();
    expect(events).toEqual(["destroyPrev old-w1"]);
  });

  it("abort after commit does nothing", async () => {
    const { rollout, events } = await setup();
    await rollout.commit();
    events.length = 0;
    await rollout.abort();
    expect(events).toEqual([]);
  });

  it("commit after abort does nothing", async () => {
    const { rollout, events } = await setup();
    await rollout.abort();
    expect(events).toEqual(["destroyNew new-worker-1"]);
    events.length = 0;
    await rollout.commit();
    expect(events).toEqual([]);
  });

  it("abort twice unwinds once", async () => {
    const { rollout, events } = await setup();
    await rollout.abort();
    await rollout.abort();
    expect(events).toEqual(["destroyNew new-worker-1"]);
  });
});

describe("rolloutRoles: concurrent teardown", () => {
  it("commit calls every destroyPrevious before any of them resolves", async () => {
    const gates = [gate(), gate(), gate()];
    const called: string[] = [];
    const { deps } = harness({
      roles: [worker(1)],
      previous: [ref("worker", 1, "old-1"), ref("worker", 2, "old-2"), ref("worker", 3, "old-3")],
      destroyPrevious: async (id) => {
        called.push(id);
        await gates[called.length - 1]!.promise;
      },
    });
    const rollout = await rolloutRoles(deps);
    let done = false;
    const committing = rollout.commit().then(() => {
      done = true;
    });
    await tick();
    expect(called).toEqual(["old-1", "old-2", "old-3"]);
    expect(done).toBe(false);
    gates.forEach((g) => g.release());
    await committing;
    expect(done).toBe(true);
  });

  it("the unwind calls every destroyStarted before any resolves, and restarts only after all settle", async () => {
    const gates = [gate(), gate(), gate()];
    const events: string[] = [];
    const { deps } = harness({
      roles: [worker(2), scheduler("sched")],
      previous: [ref("sched", 1, "old-sched")],
      destroyStarted: async (id) => {
        events.push(`destroyNew ${id}`);
        await gates[events.filter((e) => e.startsWith("destroyNew")).length - 1]!.promise;
        events.push(`settled ${id}`);
      },
      startPrevious: async (id) => {
        events.push(`startPrev ${id}`);
      },
    });
    const rollout = await rolloutRoles(deps);
    events.length = 0;
    const aborting = rollout.abort();
    await tick();
    expect(calls(events, "destroyNew")).toEqual([
      "destroyNew new-sched-1",
      "destroyNew new-worker-1",
      "destroyNew new-worker-2",
    ]);
    expect(events.some((e) => e.startsWith("settled"))).toBe(false);
    // Two of three settled: the restart must still wait for the last one.
    gates[0]!.release();
    gates[1]!.release();
    await tick();
    expect(events.some((e) => e.startsWith("startPrev"))).toBe(false);
    gates[2]!.release();
    await aborting;
    const firstRestart = events.findIndex((e) => e.startsWith("startPrev"));
    const lastSettled = events.map((e) => e.startsWith("settled")).lastIndexOf(true);
    expect(firstRestart).toBeGreaterThan(lastSettled);
    expect(events.filter((e) => e.startsWith("settled"))).toHaveLength(3);
  });

  it("restarts every retained container concurrently", async () => {
    const gates = [gate(), gate()];
    const called: string[] = [];
    const { deps } = harness({
      roles: [scheduler("sched")],
      previous: [ref("sched", 1, "old-a"), ref("sched", 2, "old-b")],
      verify: async () => "down",
      startPrevious: async (id) => {
        called.push(id);
        await gates[called.length - 1]!.promise;
      },
    });
    const failing = rolloutRoles(deps).catch((e: unknown) => e);
    await tick();
    expect(called).toEqual(["old-a", "old-b"]);
    gates.forEach((g) => g.release());
    await failing;
  });

  it("N hung destroys cost about one timeout, not N", async () => {
    const N = 6;
    const timeoutMs = 100;
    const { deps, warnings } = harness({
      roles: [worker(1)],
      previous: Array.from({ length: N }, (_, i) => ref("worker", i + 1, `old-${i + 1}`)),
      teardownTimeoutMs: timeoutMs,
      destroyPrevious: () => never(),
    });
    const rollout = await rolloutRoles(deps);
    const startedAt = Date.now();
    await rollout.commit();
    const elapsed = Date.now() - startedAt;
    expect(warnings).toHaveLength(N);
    // Sequential would take N * timeoutMs = 600ms; leave a wide margin for load.
    expect(elapsed).toBeLessThan(timeoutMs * 4);
  });
});
