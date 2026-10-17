/**
 * GH-676: per-build-host cap on concurrent image builds. One push that fans out
 * to several auto-deploying projects must queue their builds on a host instead
 * of running them all against one Docker/containerd store at once.
 */
import { describe, expect, it } from "vitest";
import {
  acquireBuildSlot,
  buildHostKey,
  buildSlotState,
  withBuildSlot,
} from "@repo/platform/engine/modules/deployments/build-slots";
import { DeploymentCancelledError } from "@repo/platform/engine/modules/deployments/deployment-cancellation";

let n = 0;
/** A fresh host key per test so module-level state never leaks between cases. */
const host = () => `test-host-${++n}`;

/** Resolves once every queued microtask has run. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("buildHostKey", () => {
  it("keys a server deploy by server and a local deploy by this machine", () => {
    expect(buildHostKey("srv_1")).toBe("server:srv_1");
    expect(buildHostKey(null)).toBe("local");
    expect(buildHostKey(undefined)).toBe("local");
  });
});

describe("acquireBuildSlot", () => {
  it("serializes builds on one host at the default limit of 1, in FIFO order", async () => {
    const key = host();
    const started: string[] = [];
    const waits: number[] = [];

    const first = await acquireBuildSlot(key, 1);
    const second = acquireBuildSlot(key, 1, { onWait: (ahead) => waits.push(ahead) }).then((r) => {
      started.push("second");
      return r;
    });
    const third = acquireBuildSlot(key, 1, { onWait: (ahead) => waits.push(ahead) }).then((r) => {
      started.push("third");
      return r;
    });

    await flush();
    expect(started).toEqual([]);
    expect(waits).toEqual([1, 2]);
    expect(buildSlotState(key)).toEqual({ running: 1, queued: 2 });

    first();
    (await second)();
    (await third)();
    expect(started).toEqual(["second", "third"]);
    expect(buildSlotState(key)).toEqual({ running: 0, queued: 0 });
  });

  it("lets up to `limit` builds run at once", async () => {
    const key = host();
    const a = await acquireBuildSlot(key, 2);
    const b = await acquireBuildSlot(key, 2);
    let cStarted = false;
    const c = acquireBuildSlot(key, 2).then((r) => {
      cStarted = true;
      return r;
    });
    await flush();
    expect(cStarted).toBe(false);
    a();
    (await c)();
    b();
    expect(buildSlotState(key)).toEqual({ running: 0, queued: 0 });
  });

  it("does not cap other hosts", async () => {
    const a = await acquireBuildSlot(host(), 1);
    const b = await acquireBuildSlot(host(), 1);
    a();
    b();
  });

  it("is uncapped at limit 0", async () => {
    const key = host();
    const releases = await Promise.all([1, 2, 3].map(() => acquireBuildSlot(key, 0)));
    expect(buildSlotState(key)).toEqual({ running: 0, queued: 0 });
    releases.forEach((release) => release());
  });

  it("drops a cancelled deploy out of the queue without taking a slot", async () => {
    const key = host();
    const first = await acquireBuildSlot(key, 1);
    const controller = new AbortController();
    const cancelled = acquireBuildSlot(key, 1, { signal: controller.signal });
    let nextStarted = false;
    const next = acquireBuildSlot(key, 1).then((r) => {
      nextStarted = true;
      return r;
    });

    controller.abort();
    await expect(cancelled).rejects.toBeInstanceOf(DeploymentCancelledError);
    expect(buildSlotState(key)).toEqual({ running: 1, queued: 1 });

    first();
    (await next)();
    expect(nextStarted).toBe(true);
    expect(buildSlotState(key)).toEqual({ running: 0, queued: 0 });
  });

  it("rejects immediately when already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(acquireBuildSlot(host(), 1, { signal: controller.signal })).rejects.toBeInstanceOf(
      DeploymentCancelledError,
    );
  });

  it("treats a second release as a no-op", async () => {
    const key = host();
    const release = await acquireBuildSlot(key, 1);
    const other = await acquireBuildSlot(host(), 1);
    release();
    release();
    expect(buildSlotState(key)).toEqual({ running: 0, queued: 0 });
    other();
  });
});

describe("withBuildSlot", () => {
  it("releases the slot when the build throws", async () => {
    const key = host();
    await expect(
      withBuildSlot(key, 1, async () => {
        throw new Error("docker build failed");
      }),
    ).rejects.toThrow("docker build failed");
    expect(buildSlotState(key)).toEqual({ running: 0, queued: 0 });
  });

  it("never runs more than `limit` builds at the same time", async () => {
    const key = host();
    let active = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 6 }, () =>
        withBuildSlot(key, 2, async () => {
          active++;
          peak = Math.max(peak, active);
          await new Promise((resolve) => setTimeout(resolve, 5));
          active--;
        }),
      ),
    );
    expect(peak).toBe(2);
  });
});
