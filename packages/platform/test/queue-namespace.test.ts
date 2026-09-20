import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QueueBase, QueueOptions } from "bullmq";

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

async function start(namespace?: string) {
  vi.stubEnv("OPENSHIP_INSTANCE_NAMESPACE", namespace);
  const runner = new BullMQJobRunner();
  runners.push(runner);
  await runner.start({ processRun: async () => {} });
}

describe("backup queue namespace compatibility", () => {
  it("preserves BullMQ's existing API queue defaults when no native namespace is configured", async () => {
    await start();
    expect(observed.queues).toHaveLength(4);
    for (const queue of observed.queues) {
      expect(queue.qualifiedName).toBe(`bull:${queue.name}`);
      expect(queue.clientName()).toBe(`bull:${Buffer.from(queue.name).toString("base64")}`);
      expect(queue.opts.prefix).toBe("bull");
    }
  });

  it("gives each native installation its own queue keys and matching workers", async () => {
    await start("installation-a");
    await start("installation-b");
    expect(observed.queues).toHaveLength(8);
    for (const [index, namespace] of ["installation-a", "installation-b"].entries()) {
      const [run, recurring, runWorker, recurringWorker] = observed.queues.slice(
        index * 4,
        index * 4 + 4,
      );
      expect(run!.qualifiedName).toBe(`${namespace}:backup-run`);
      expect(recurring!.qualifiedName).toBe(`${namespace}:backup-recurring`);
      expect(runWorker!.keys).toEqual(run!.keys);
      expect(recurringWorker!.keys).toEqual(recurring!.keys);
    }
    expect(observed.queues[0]!.toKey("wait")).not.toBe(observed.queues[4]!.toKey("wait"));
  });
});
