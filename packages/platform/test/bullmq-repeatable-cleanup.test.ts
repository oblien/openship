import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QueueBase, QueueOptions, RepeatableJob } from "bullmq";

const observed = vi.hoisted(() => ({ queues: [] as QueueBase[] }));

vi.mock("../src/engine/config/env", () => ({ env: { REDIS_URL: "redis://unused.invalid" } }));
vi.mock("ioredis", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    default: class extends EventEmitter {
      disconnect() {}
    },
  };
});
vi.mock("bullmq", async (importOriginal) => {
  const actual = await importOriginal<typeof import("bullmq")>();
  const { EventEmitter } = await import("node:events");
  class OfflineConnection extends EventEmitter {
    async close() {}
  }
  // Exercise BullMQ's real option defaults and key/client naming without Redis I/O.
  function queue(name: string, options: QueueOptions) {
    const instance = new actual.QueueBase(
      name,
      options,
      OfflineConnection as unknown as typeof actual.RedisConnection,
    );
    observed.queues.push(instance);
    return instance;
  }
  return {
    ...actual,
    Queue: class {
      constructor(name: string, options: QueueOptions) {
        return queue(name, options);
      }
    },
    Worker: class {
      constructor(name: string, _processor: unknown, options: QueueOptions) {
        return queue(name, options);
      }
    },
  };
});

import { BullMQJobRunner } from "../src/engine/lib/job-runner/bullmq";

const runners: BullMQJobRunner[] = [];
beforeEach(() => {
  observed.queues.length = 0;
});
afterEach(async () => {
  await Promise.all(runners.splice(0).map((runner) => runner.shutdown()));
  vi.unstubAllEnvs();
});

interface FakeRecurringQueue {
  getRepeatableJobs: ReturnType<typeof vi.fn>;
  add: ReturnType<typeof vi.fn>;
  removeRepeatableByKey: ReturnType<typeof vi.fn>;
}

async function startWithRepeatables(repeatables: RepeatableJob[]) {
  vi.stubEnv("OPENSHIP_INSTANCE_NAMESPACE", undefined);
  const runner = new BullMQJobRunner();
  runners.push(runner);
  await runner.start({ processRun: async () => {} });
  const recurring = observed.queues.find(
    (queue) => queue.name === "backup-recurring",
  ) as unknown as FakeRecurringQueue;
  recurring.getRepeatableJobs = vi.fn().mockResolvedValue(repeatables);
  recurring.add = vi.fn().mockResolvedValue({ id: "new-job" });
  recurring.removeRepeatableByKey = vi.fn().mockResolvedValue(1);
  return { runner, recurring };
}

const staleRepeatable = (overrides: Partial<RepeatableJob> = {}): RepeatableJob => ({
  key: "deadbeef",
  name: "policy:1",
  id: null,
  endDate: null,
  tz: null,
  pattern: "0 4 * * *",
  every: null,
  next: 0,
  ...overrides,
});

describe("BullMQ recurring cleanup", () => {
  it("removes the stale repeatable when a cron edit reschedules the same job", async () => {
    const { runner, recurring } = await startWithRepeatables([staleRepeatable()]);
    await runner.scheduleRecurring({
      jobId: "policy:1",
      cronExpression: "0 1 * * *",
      onTick: async () => {},
    });
    expect(recurring.removeRepeatableByKey).toHaveBeenCalledWith("deadbeef");
    expect(recurring.add).toHaveBeenCalledWith(
      "policy:1",
      { jobId: "policy:1" },
      expect.objectContaining({ repeat: { pattern: "0 1 * * *" } }),
    );
  });

  it("removes the stale repeatable on disable even when BullMQ omits the id", async () => {
    const repeatable = staleRepeatable();
    delete (repeatable as Partial<RepeatableJob>).id;
    const { runner, recurring } = await startWithRepeatables([repeatable]);
    await runner.removeRecurring("policy:1");
    expect(recurring.removeRepeatableByKey).toHaveBeenCalledWith("deadbeef");
  });

  it("leaves other jobs' repeatables alone", async () => {
    const { runner, recurring } = await startWithRepeatables([
      staleRepeatable(),
      staleRepeatable({ key: "other-key", name: "policy:2", pattern: "0 2 * * *" }),
    ]);
    await runner.scheduleRecurring({
      jobId: "policy:1",
      cronExpression: "0 1 * * *",
      onTick: async () => {},
    });
    expect(recurring.removeRepeatableByKey).toHaveBeenCalledTimes(1);
    expect(recurring.removeRepeatableByKey).toHaveBeenCalledWith("deadbeef");
  });
});
