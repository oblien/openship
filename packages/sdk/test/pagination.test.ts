import { describe, expect, it, vi } from "vitest";
import { iteratePages } from "../src/pagination";

describe("named SDK pagination", () => {
  it("follows a provider's capped page size without dropping later rows", async () => {
    const load = vi.fn(async ({ page }) => ({ data: page === 1 ? ["a", "b"] : ["c"], total: 3, page, perPage: 2 }));
    const rows = [];
    for await (const row of iteratePages(load, { perPage: 100 })) rows.push(row);
    expect(rows).toEqual(["a", "b", "c"]);
    expect(load.mock.calls).toEqual([[{ page: 1, perPage: 100 }], [{ page: 2, perPage: 100 }]]);
  });

  it("stops after an empty page even when the advertised total is stale", async () => {
    const load = vi.fn(async () => ({ data: [], total: 100 }));
    for await (const _ of iteratePages(load)) throw new Error("unexpected row");
    expect(load).toHaveBeenCalledOnce();
  });

  it("observes cancellation between rows without fetching another page", async () => {
    const abort = new AbortController();
    const load = vi.fn(async () => ({ data: ["a", "b"] }));
    const rows = iteratePages(load, { signal: abort.signal });
    expect((await rows.next()).value).toBe("a");
    abort.abort(new Error("stopped"));
    await expect(rows.next()).rejects.toThrow("stopped");
    expect(load).toHaveBeenCalledOnce();
  });

  it("rejects a repeated page instead of silently duplicating rows", async () => {
    const rows = iteratePages(async () => ({ data: ["a"], page: 1, total: 2 }), { perPage: 1 });
    expect((await rows.next()).value).toBe("a");
    await expect(rows.next()).rejects.toThrow("Invalid pagination response");
  });
});
