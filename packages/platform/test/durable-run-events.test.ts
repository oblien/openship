import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { durableRunEvents } from "../src/engine/lib/durable-run-events";

type Run = { sequence: number; status: "running" | "failed" | "ready"; logs: string[] };
let run: Run;
let listener: (() => void) | undefined;
let load: ReturnType<typeof vi.fn<() => Promise<Run>>>;
let unsubscribe: ReturnType<typeof vi.fn>;
let abort: AbortController;
const create = () =>
  durableRunEvents({
    subscribe: (changed) => {
      listener = changed;
      return unsubscribe;
    },
    load,
    version: (row) => row.sequence,
    complete: (row) => row.status !== "running",
    signal: abort.signal,
  });
beforeEach(() => {
  vi.useFakeTimers();
  run = { sequence: 1, status: "running", logs: [] };
  load = vi.fn(async () => structuredClone(run));
  unsubscribe = vi.fn(() => {
    listener = undefined;
  });
  abort = new AbortController();
});
afterEach(() => {
  abort.abort();
  vi.useRealTimers();
});

describe("durable run event snapshots", () => {
  it("subscribes before reading and cannot lose an update during the initial snapshot", async () => {
    let resolve!: (run: Run) => void;
    load.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const events = create();
    const first = events.next();
    expect(listener).toBeTypeOf("function");
    run.sequence = 2;
    run.logs = ["Python installed"];
    listener!();
    resolve({ sequence: 1, status: "running", logs: [] });
    expect((await first).value?.id).toBe("1");
    const next = await events.next();
    expect(JSON.parse(next.value!.data).run).toEqual(run);
    await events.return(undefined);
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("coalesces a slow subscriber into the latest committed state without buffering every update", async () => {
    const events = create();
    await events.next();
    for (let i = 0; i < 5000; i++) {
      run.sequence++;
      listener!();
    }
    expect(load).toHaveBeenCalledOnce();
    expect((await events.next()).value?.id).toBe("5001");
    expect(load).toHaveBeenCalledTimes(2);
    await events.return(undefined);
  });
  it("ignores unchanged notifications and reconciles another controller's writes", async () => {
    const events = create();
    await events.next();
    const delivered = vi.fn();
    const next = events.next().then((result) => {
      delivered();
      return result;
    });
    listener!();
    await vi.advanceTimersByTimeAsync(0);
    expect(delivered).not.toHaveBeenCalled();
    run = { sequence: 2, status: "failed", logs: ["Controller lease expired"] };
    await vi.advanceTimersByTimeAsync(15_000);
    expect(JSON.parse((await next).value!.data).run).toEqual(run);
    expect((await events.next()).value?.event).toBe("complete");
    expect((await events.next()).done).toBe(true);
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("replays terminal progress on reconnect, including failures, before closing", async () => {
    run = { sequence: 7, status: "failed", logs: ["Repository unavailable"] };
    for (let i = 0; i < 2; i++) {
      const received = [];
      for await (const event of create()) received.push(event);
      expect(received.map((event) => event.event)).toEqual(["snapshot", "complete"]);
      expect(JSON.parse(received[0]!.data).run).toEqual(run);
    }
    expect(unsubscribe).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("does not close on an old failed attempt when retry commits during the snapshot read", async () => {
    let resolve!: (run: Run) => void;
    load.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const events = create();
    const first = events.next();
    run = { sequence: 3, status: "running", logs: ["Resuming preparation"] };
    listener!();
    resolve({ sequence: 2, status: "failed", logs: [] });
    expect(JSON.parse((await first).value!.data).run.status).toBe("running");
    await events.return(undefined);
  });
  it("releases listeners and reconciliation timers when an idle viewer disconnects", async () => {
    const events = create();
    await events.next();
    const pending = events.next();
    abort.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("closes and cleans up when a durable read or permission recheck fails", async () => {
    const events = create();
    await events.next();
    load.mockRejectedValueOnce(new Error("Access revoked"));
    const next = events.next();
    listener!();
    await expect(next).rejects.toThrow("Access revoked");
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
