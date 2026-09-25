import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { runEvents } from "../src/engine/lib/run-events";
import type { RunBus } from "../src/engine/lib/run-bus";

type Row = { status: string; bytes: number; finishedAt: string | null };
type Event =
  | { type: "snapshot"; run: Row }
  | { type: "transition" | "complete"; status: string }
  | { type: "warning"; message: string };

function fixture(reconcile = true) {
  let row: Row = { status: "preparing", bytes: 0, finishedAt: null };
  const listeners = new Set<(event: Event) => void>();
  const unsubscribe = vi.fn((listener: (event: Event) => void) => {
    listeners.delete(listener);
  });
  const bus: RunBus<Event> = {
    publish: (_id, event) => {
      for (const listener of listeners) listener(event);
    },
    subscribe: (_id, listener) => {
      listeners.add(listener);
      return () => unsubscribe(listener);
    },
  };
  const load = vi.fn(async () => ({ ...row }));
  const abort = new AbortController();
  const stream = runEvents<Event, Row>({
    bus,
    id: "run",
    signal: abort.signal,
    load,
    snapshot: (run) => ({ type: "snapshot", run }),
    complete: (run) =>
      run.status === "succeeded" ? { type: "complete", status: run.status } : null,
    reconcile: reconcile
      ? { everyMs: 5_000, isTransient: (event) => event.type === "warning" }
      : undefined,
  })[Symbol.asyncIterator]();
  return {
    stream,
    load,
    abort,
    unsubscribe,
    listeners,
    publish: (event: Event) => bus.publish("run", event),
    save: (patch: Partial<Row>) => {
      row = { ...row, ...patch };
    },
  };
}
const payload = (result: IteratorResult<{ data: string }>) => JSON.parse(result.value!.data);

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

it("recovers a separate worker's progress and exact completion without any bus notifications", async () => {
  const f = fixture();
  expect(payload(await f.stream.next())).toMatchObject({
    type: "snapshot",
    run: { status: "preparing" },
  });
  f.save({ status: "uploading", bytes: 1234 });
  const progress = f.stream.next();
  await vi.advanceTimersByTimeAsync(5_000);
  expect(payload(await progress)).toMatchObject({ run: { status: "uploading", bytes: 1234 } });
  f.save({ status: "succeeded", bytes: 4567, finishedAt: "2026-09-25T11:06:00.042Z" });
  const final = f.stream.next();
  await vi.advanceTimersByTimeAsync(5_000);
  expect(payload(await final)).toEqual({
    type: "snapshot",
    run: {
      status: "succeeded",
      bytes: 4567,
      finishedAt: "2026-09-25T11:06:00.042Z",
    },
  });
  expect(payload(await f.stream.next())).toEqual({ type: "complete", status: "succeeded" });
  expect((await f.stream.next()).done).toBe(true);
  expect(f.unsubscribe).toHaveBeenCalledOnce();
  expect(f.listeners.size).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});

it("coalesces state notifications and reads the saved verdict before closing", async () => {
  const f = fixture();
  await f.stream.next();
  f.save({ status: "succeeded", bytes: 100, finishedAt: "2026-09-25T11:06:00Z" });
  f.publish({ type: "transition", status: "uploading" });
  f.publish({ type: "transition", status: "verifying" });
  f.publish({ type: "complete", status: "failed" });
  const final = f.stream.next();
  await vi.advanceTimersByTimeAsync(200);
  expect(payload(await final)).toMatchObject({
    type: "snapshot",
    run: { status: "succeeded", bytes: 100 },
  });
  expect(payload(await f.stream.next())).toEqual({ type: "complete", status: "succeeded" });
  await f.stream.next();
  expect(f.load).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
});

it("does not replay older transitions over the initial durable snapshot", async () => {
  const f = fixture();
  const loaded = Promise.withResolvers<Row>();
  f.load.mockReturnValueOnce(loaded.promise);
  const first = f.stream.next();
  f.publish({ type: "transition", status: "preparing" });
  f.publish({ type: "transition", status: "uploading" });
  f.save({ status: "verifying", bytes: 100 });
  loaded.resolve({ status: "verifying", bytes: 100, finishedAt: null });
  expect(payload(await first)).toMatchObject({ run: { status: "verifying" } });
  f.save({ status: "succeeded", finishedAt: "2026-09-25T11:06:00Z" });
  const next = f.stream.next();
  await vi.advanceTimersByTimeAsync(200);
  expect(payload(await next)).toMatchObject({ type: "snapshot", run: { status: "succeeded" } });
  await f.stream.return?.();
  expect(vi.getTimerCount()).toBe(0);
});

it("serializes slow reads and reconciles an update that arrives during one", async () => {
  const f = fixture();
  await f.stream.next();
  const slow = Promise.withResolvers<Row>();
  f.load.mockReturnValueOnce(slow.promise);
  await vi.advanceTimersByTimeAsync(5_000);
  f.save({ status: "uploading", bytes: 100 });
  for (let n = 0; n < 20; n++) f.publish({ type: "transition", status: "uploading" });
  await vi.advanceTimersByTimeAsync(20_000);
  expect(f.load).toHaveBeenCalledTimes(2);
  const next = f.stream.next();
  slow.resolve({ status: "preparing", bytes: 0, finishedAt: null });
  await vi.advanceTimersByTimeAsync(200);
  expect(payload(await next)).toMatchObject({ run: { status: "uploading", bytes: 100 } });
  expect(f.load).toHaveBeenCalledTimes(3);
  await f.stream.return?.();
  expect(vi.getTimerCount()).toBe(0);
});

it("forwards transient advisories without fetching or dropping them during initial load", async () => {
  const f = fixture();
  const initial = f.stream.next();
  f.publish({ type: "warning", message: "Checksum unavailable" });
  await initial;
  expect(payload(await f.stream.next())).toEqual({
    type: "warning",
    message: "Checksum unavailable",
  });
  f.publish({ type: "warning", message: "Size verified" });
  expect(payload(await f.stream.next())).toEqual({ type: "warning", message: "Size verified" });
  expect(f.load).toHaveBeenCalledOnce();
  await f.stream.return?.();
});

it("does not send duplicate snapshots on an unchanged run", async () => {
  const f = fixture();
  await f.stream.next();
  const next = f.stream.next();
  const cancelled = expect(next).rejects.toMatchObject({ name: "AbortError" });
  await vi.advanceTimersByTimeAsync(15_000);
  expect(f.load).toHaveBeenCalledTimes(4);
  f.abort.abort();
  await cancelled;
  expect(f.unsubscribe).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it("stops timers immediately on abort even while a durable read is pending", async () => {
  const f = fixture();
  await f.stream.next();
  const slow = Promise.withResolvers<Row>();
  f.load.mockReturnValueOnce(slow.promise);
  const next = f.stream.next();
  const cancelled = expect(next).rejects.toMatchObject({ name: "AbortError" });
  await vi.advanceTimersByTimeAsync(5_000);
  f.abort.abort();
  await cancelled;
  expect(f.listeners.size).toBe(0);
  slow.resolve({ status: "uploading", bytes: 500, finishedAt: null });
  await vi.advanceTimersByTimeAsync(20_000);
  expect(f.load).toHaveBeenCalledTimes(2);
  expect(f.unsubscribe).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it("closes a failed reconciliation so clients reconnect instead of receiving heartbeats forever", async () => {
  const f = fixture();
  await f.stream.next();
  f.load.mockRejectedValueOnce(new Error("Database unavailable"));
  const next = expect(f.stream.next()).rejects.toThrow("Database unavailable");
  await vi.advanceTimersByTimeAsync(5_000);
  await next;
  expect(f.unsubscribe).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it("closes completed initial snapshots without starting reconciliation", async () => {
  const f = fixture();
  f.save({ status: "succeeded", bytes: 500, finishedAt: "2026-09-25T11:06:00Z" });
  expect(payload(await f.stream.next()).run.status).toBe("succeeded");
  expect(payload(await f.stream.next()).type).toBe("complete");
  expect((await f.stream.next()).done).toBe(true);
  expect(f.load).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it("bounds buffered advisories and unsubscribes when their consumer falls behind", async () => {
  const f = fixture();
  const slow = Promise.withResolvers<Row>();
  f.load.mockReturnValueOnce(slow.promise);
  const first = expect(f.stream.next()).rejects.toMatchObject({ code: "EVENT_BACKPRESSURE" });
  for (let n = 0; n < 1_025; n++) f.publish({ type: "warning", message: "Advisory" });
  slow.resolve({ status: "preparing", bytes: 0, finishedAt: null });
  await first;
  expect(f.unsubscribe).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it("preserves existing live event delivery for callers without durable reconciliation", async () => {
  const f = fixture(false);
  const first = f.stream.next();
  f.publish({ type: "transition", status: "uploading" });
  expect(payload(await first).type).toBe("snapshot");
  expect(payload(await f.stream.next())).toEqual({ type: "transition", status: "uploading" });
  f.publish({ type: "complete", status: "succeeded" });
  expect(payload(await f.stream.next()).type).toBe("complete");
  expect((await f.stream.next()).done).toBe(true);
  expect(f.load).toHaveBeenCalledOnce();
  expect(f.unsubscribe).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});
