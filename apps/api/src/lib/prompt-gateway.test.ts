import { describe, it, expect, vi } from "vitest";
import { PromptRegistry } from "./prompt-gateway";

describe("PromptRegistry", () => {
  it("resolves the awaiting promise with the chosen action", async () => {
    const reg = new PromptRegistry();
    const p = reg.wait("s1");
    expect(reg.has("s1")).toBe(true);
    expect(reg.respond("s1", "migrate")).toBe(true);
    await expect(p).resolves.toBe("migrate");
    expect(reg.has("s1")).toBe(false);
  });

  it("respond() is false when nothing is pending for the key", () => {
    expect(new PromptRegistry().respond("nope", "x")).toBe(false);
  });

  it("reject() rejects the awaiting promise and clears it", async () => {
    const reg = new PromptRegistry();
    const p = reg.wait("s1");
    expect(reg.reject("s1", "torn down")).toBe(true);
    await expect(p).rejects.toThrow("torn down");
    expect(reg.has("s1")).toBe(false);
    expect(reg.reject("s1", "again")).toBe(false); // already cleared
  });

  it("times out and runs onTimeout before rejecting", async () => {
    vi.useFakeTimers();
    try {
      const reg = new PromptRegistry(1000);
      const onTimeout = vi.fn();
      const p = reg.wait("s1", onTimeout);
      const assertion = expect(p).rejects.toThrow("timed out");
      await vi.advanceTimersByTimeAsync(1000);
      await assertion;
      expect(onTimeout).toHaveBeenCalledOnce();
      expect(reg.has("s1")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keys are independent — one session's answer doesn't affect another", async () => {
    const reg = new PromptRegistry();
    const a = reg.wait("a");
    const b = reg.wait("b");
    reg.respond("a", "override");
    await expect(a).resolves.toBe("override");
    expect(reg.has("b")).toBe(true);
    reg.respond("b", "cancel");
    await expect(b).resolves.toBe("cancel");
  });
});
