import { afterEach, beforeEach, expect, it, vi } from "vitest";

const { listQueued } = vi.hoisted(() => ({ listQueued: vi.fn() }));
vi.mock("@repo/db", () => ({ repos: { backupRun: { listQueued } } }));
import { InProcessJobRunner } from "../src/engine/lib/job-runner/in-process";
import { deferBackgroundWork, drainBackgroundWork } from "../src/engine/lib/background-work";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-09-12T00:00:00Z")); listQueued.mockReset().mockResolvedValue([]); });
afterEach(() => { vi.useRealTimers(); });

it("drains accepted queued runs even when shutdown wins the setImmediate race", async () => {
  const runner = new InProcessJobRunner();
  const gate = deferred();
  const seen: string[] = [];
  await runner.start({ processRun: async id => { seen.push(id); if (seen.length <= 2) await gate.promise; } });
  for (const id of ["first", "second", "third", "fourth"]) await runner.enqueueRun(id);
  const closing = runner.shutdown(Infinity);
  await vi.advanceTimersByTimeAsync(0);
  expect(seen).toEqual(["first", "second"]);
  gate.resolve();
  await closing;
  expect(seen).toEqual(["first", "second", "third", "fourth"]);
  expect(vi.getTimerCount()).toBe(0);
});

it("waits for an active recurring callback and the run it enqueues", async () => {
  const runner = new InProcessJobRunner();
  const gate = deferred();
  const processRun = vi.fn(async () => {});
  await runner.start({ processRun });
  await runner.scheduleRecurring({ jobId: "policy", cronExpression: "* * * * * *", onTick: async () => { await gate.promise; await runner.enqueueRun("from-tick"); } });
  await vi.advanceTimersByTimeAsync(1000);
  let closed = false;
  const closing = runner.shutdown(Infinity).then(() => { closed = true; });
  await Promise.resolve();
  expect(closed).toBe(false);
  gate.resolve();
  await closing;
  expect(processRun).toHaveBeenCalledWith("from-tick");
  await vi.advanceTimersByTimeAsync(0);
  expect(vi.getTimerCount()).toBe(0);
});

it("waits for an in-progress queue poll before releasing its storage owner", async () => {
  const runner = new InProcessJobRunner();
  const poll = deferred<Array<{ id: string }>>();
  const processRun = vi.fn(async () => {});
  await runner.start({ processRun });
  listQueued.mockReturnValue(poll.promise);
  await vi.advanceTimersByTimeAsync(30_000);
  let closed = false;
  const closing = runner.shutdown(Infinity).then(() => { closed = true; });
  await Promise.resolve();
  expect(closed).toBe(false);
  poll.resolve([{ id: "from-poll" }]);
  await closing;
  expect(processRun).toHaveBeenCalledWith("from-poll");
});

it("does not re-arm an old recurring callback after a schedule replacement", async () => {
  const runner = new InProcessJobRunner();
  const gate = deferred();
  const oldTick = vi.fn(() => gate.promise), newTick = vi.fn(async () => {});
  await runner.start({ processRun: async () => {} });
  await runner.scheduleRecurring({ jobId: "policy", cronExpression: "* * * * * *", onTick: oldTick });
  await vi.advanceTimersByTimeAsync(1000);
  await runner.scheduleRecurring({ jobId: "policy", cronExpression: "* * * * * *", onTick: newTick });
  gate.resolve();
  await vi.advanceTimersByTimeAsync(1000);
  expect(oldTick).toHaveBeenCalledTimes(1);
  expect(newTick).toHaveBeenCalledTimes(1);
  await runner.shutdown(Infinity);
});

it("tracks deferred restore/fallback work before its callback starts", async () => {
  const gate = deferred();
  const work = vi.fn(() => gate.promise);
  void deferBackgroundWork(work);
  let drained = false;
  const closing = drainBackgroundWork().then(() => { drained = true; });
  await Promise.resolve();
  expect(work).not.toHaveBeenCalled();
  expect(drained).toBe(false);
  await vi.advanceTimersByTimeAsync(0);
  expect(work).toHaveBeenCalledOnce();
  expect(drained).toBe(false);
  gate.resolve();
  await closing;
  expect(drained).toBe(true);
});

it("does not fire a distant cron date when its timeout exceeds Node's timer range", async () => {
  const runner = new InProcessJobRunner();
  const onTick = vi.fn(async () => {});
  await runner.start({ processRun: async () => {} });
  await runner.scheduleRecurring({ jobId: "yearly", cronExpression: "0 0 1 1 *", onTick });
  await vi.advanceTimersByTimeAsync(2000);
  expect(onTick).not.toHaveBeenCalled();
  await runner.shutdown(Infinity);
});
