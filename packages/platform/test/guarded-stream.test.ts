import { describe, expect, it, vi } from "vitest";
import { guardedStream } from "../src/guarded-stream";

describe("owned guarded streams", () => {
  it("closes an unopened iterator and its resource exactly once", async () => {
    const source = { next: vi.fn(async () => ({ done: false as const, value: 1 })), return: vi.fn(async () => ({ done: true as const, value: undefined })), [Symbol.asyncIterator]() { return this; } };
    const close = vi.fn(async () => {});
    const stream = guardedStream(source, { close });
    await Promise.all([stream.return!(), stream.return!()]);
    expect(source.next).not.toHaveBeenCalled();
    expect(source.return).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(await stream.next()).toEqual({ done: true, value: undefined });
  });

  it("rechecks authority after a pending read and hides its result on revocation", async () => {
    let permitted = true;
    let emit!: (value: IteratorResult<string>) => void;
    let started!: () => void;
    const reading = new Promise<void>(resolve => { started = resolve; });
    const close = vi.fn(async () => {});
    const denied = new Error("Revoked");
    const source = { next: () => { started(); return new Promise<IteratorResult<string>>(resolve => { emit = resolve; }); }, return: close, [Symbol.asyncIterator]() { return this; } };
    const stream = guardedStream(source as AsyncIterable<string>, { check: async () => { if (!permitted) throw denied; } });
    const next = stream.next();
    await reading;
    permitted = false;
    emit({ done: false, value: "private" });
    await expect(next).rejects.toBe(denied);
    expect(close).toHaveBeenCalledOnce();
    expect((await stream.next()).done).toBe(true);
  });

  it("interrupts a pending read before disposal and never returns a late event", async () => {
    let emit!: (value: IteratorResult<number>) => void;
    let started!: () => void;
    const reading = new Promise<void>(resolve => { started = resolve; });
    const settled: string[] = [];
    const source = {
      async *[Symbol.asyncIterator]() {
        try {
          started();
          const result = await new Promise<IteratorResult<number>>(resolve => { emit = resolve; });
          settled.push("read");
          yield result.value!;
        } finally { settled.push("iterator"); }
      },
    };
    const stream = guardedStream(source, {
      cancel: () => { settled.push("cancel"); emit({ done: false, value: 42 }); },
      close: async () => { settled.push("resource"); },
    });
    const next = stream.next();
    await reading;
    await stream.return!();
    expect(await next).toEqual({ done: true, value: undefined });
    expect(settled).toEqual(["cancel", "read", "iterator", "resource"]);
  });

  it("keeps the authorization error when cleanup also fails", async () => {
    const denied = new Error("Denied");
    const dispose = vi.fn(async () => { throw new Error("Cleanup failed"); });
    async function* source() { yield 1; }
    const stream = guardedStream(source(), { check: async () => { throw denied; }, close: dispose });
    await expect(stream.next()).rejects.toBe(denied);
    expect(dispose).toHaveBeenCalledOnce();
  });
});
