import { afterEach, describe, expect, it, vi } from "vitest";

import { closeAuthWindowAfterSuccess, openAuthWindow } from "./authWindow";

describe("closeAuthWindowAfterSuccess", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
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

describe("openAuthWindow", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reports when popup protection blocked the reserved window", () => {
    vi.stubGlobal("window", {
      screen: { width: 1440, height: 900 },
      open: vi.fn(() => null),
    });

    expect(openAuthWindow().blocked).toBe(true);
  });

  it("reserves a browser window before navigating to the async auth URL", () => {
    const popup = {
      closed: false,
      location: { href: "about:blank" },
      focus: vi.fn(),
      close: vi.fn(),
    };
    vi.stubGlobal("window", {
      screen: { width: 1440, height: 900 },
      open: vi.fn(() => popup),
    });

    const handle = openAuthWindow();
    handle.navigate("https://api.openship.io/api/github/connect/redirect");

    expect(handle.blocked).toBe(false);
    expect(popup.location.href).toBe("https://api.openship.io/api/github/connect/redirect");
    expect(popup.focus).toHaveBeenCalledOnce();
  });
});
