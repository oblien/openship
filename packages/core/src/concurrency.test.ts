import { describe, expect, it } from "vitest";
import { mapConcurrent, runDependencyTasks } from "./concurrency";

const gate = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
};

describe("bounded deployment work", () => {
  it("runs independent work together and keeps the caller's result order", async () => {
    const first = gate(),
      second = gate(),
      started = gate();
    const starts: number[] = [];
    const work = mapConcurrent([1, 2], 2, async (value) => {
      starts.push(value);
      if (starts.length === 2) started.resolve();
      await (value === 1 ? first.promise : second.promise);
      return value;
    });
    await started.promise;
    second.resolve();
    first.resolve();
    expect(await work).toEqual([1, 2]);
  });

  it("does not clean up while another started command is still running", async () => {
    const drain = gate(),
      started = gate();
    const calls: number[] = [];
    let settled = false;
    const work = mapConcurrent([1, 2, 3], 2, async (value) => {
      calls.push(value);
      if (value === 1) {
        await started.promise;
        throw new Error("failed");
      }
      started.resolve();
      await drain.promise;
    }).finally(() => {
      settled = true;
    });
    const rejected = expect(work).rejects.toThrow("failed");
    await started.promise;
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    drain.resolve();
    await rejected;
    expect(calls).toEqual([1, 2]);
  });
});

describe("dependency-aware service activation", () => {
  it("releases startup dependents before publication while still draining publication", async () => {
    const publish = gate(),
      child = gate();
    let settled = false;
    const work = runDependencyTasks(["db", "app"], {
      key: (name) => name,
      dependencies: (name) => (name === "app" ? ["db"] : []),
      concurrency: 1,
      run: async (name, ready) => {
        if (name === "db") {
          ready();
          ready();
          await publish.promise;
        } else child.resolve();
      },
    }).finally(() => {
      settled = true;
    });
    await child.promise;
    expect(settled).toBe(false);
    publish.resolve();
    await work;
  });

  it("starts ready services together and releases a dependent without waiting for unrelated work", async () => {
    const db = gate(),
      slow = gate(),
      both = gate(),
      app = gate();
    const starts: string[] = [];
    const work = runDependencyTasks(
      [
        { name: "app", deps: ["db"] },
        { name: "db", deps: [] },
        { name: "slow", deps: [] },
      ],
      {
        key: (s) => s.name,
        dependencies: (s) => s.deps,
        concurrency: 2,
        run: async (s) => {
          starts.push(s.name);
          if (starts.length === 2) both.resolve();
          if (s.name === "db") await db.promise;
          else if (s.name === "slow") await slow.promise;
          else app.resolve();
        },
      },
    );
    await both.promise;
    expect(starts).toEqual(["db", "slow"]);
    db.resolve();
    await app.promise;
    expect(starts).toEqual(["db", "slow", "app"]);
    slow.resolve();
    await work;
  });

  it("rejects cycles before any activation starts", async () => {
    const started: string[] = [];
    await expect(
      runDependencyTasks(
        [
          { name: "a", deps: ["b"] },
          { name: "b", deps: ["a"] },
        ],
        {
          key: (s) => s.name,
          dependencies: (s) => s.deps,
          concurrency: 2,
          run: async (s) => {
            started.push(s.name);
          },
        },
      ),
    ).rejects.toThrow("Circular service dependency");
    expect(started).toEqual([]);
  });

  it("never starts children of a rejected dependency and drains unrelated work", async () => {
    const release = gate();
    const starts: string[] = [];
    const work = runDependencyTasks(
      [
        { name: "db", deps: [] },
        { name: "app", deps: ["db"] },
        { name: "other", deps: [] },
      ],
      {
        key: (s) => s.name,
        dependencies: (s) => s.deps,
        concurrency: 2,
        run: async (s) => {
          starts.push(s.name);
          if (s.name === "db") throw new Error("database failed");
          await release.promise;
        },
      },
    );
    const rejected = expect(work).rejects.toThrow("database failed");
    release.resolve();
    await rejected;
    expect(starts).not.toContain("app");
  });
});
