import { afterEach, describe, expect, it, vi } from "vitest";

import { closeAuthWindowAfterSuccess } from "./authWindow";

describe("closeAuthWindowAfterSuccess", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("closes a script-opened auth popup even when no opener is available", () => {
    vi.useFakeTimers();
    const close = vi.fn();

    closeAuthWindowAfterSuccess(600, { close });

    expect(close).not.toHaveBeenCalled();
    vi.advanceTimersByTime(600);
    expect(close).toHaveBeenCalledOnce();
  });

  it("does not surface a browser close error after connection succeeds", () => {
    vi.useFakeTimers();
    const close = vi.fn(() => {
      throw new Error("close denied");
    });

    closeAuthWindowAfterSuccess(0, { close });

    expect(() => vi.runAllTimers()).not.toThrow();
    expect(close).toHaveBeenCalledOnce();
  });
});
