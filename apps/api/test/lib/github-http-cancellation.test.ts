import { afterEach, describe, expect, it, vi } from "vitest";
import { ghFetch } from "@repo/platform/engine/modules/github/github.http";
afterEach(() => vi.unstubAllGlobals());
describe("GitHub caller cancellation", () => {
  it("retains the caller deadline alongside the shared HTTP timeout", async () => {
    const controller = new AbortController();
    const request = vi.fn(
      async (_url, init) =>
        new Promise<Response>((_, reject) => {
          const signal = init.signal as AbortSignal;
          if (signal.aborted) reject(signal.reason);
          else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
    );
    vi.stubGlobal("fetch", request);
    const pending = ghFetch("test-token", {
      url: "https://api.github.com/repos/test/repo/git/trees/commit",
      signal: controller.signal,
    });
    controller.abort(new Error("Impact deadline"));
    await expect(pending).rejects.toThrow("Impact deadline");
    expect(request).toHaveBeenCalledOnce();
  });
});
