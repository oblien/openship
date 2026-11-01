// @vitest-environment happy-dom
import type { Terminal } from "@xterm/xterm";
import { expect, it, vi } from "vitest";
import { APPEARANCE_CHANGED } from "./appearance-runtime";
import { observeTerminalAppearance } from "./terminal-appearance";

it("updates the mounted terminal, refits only for typography changes, and removes its subscription", () => {
  const element = document.createElement("div");
  document.body.append(element);
  const terminal = {
    options: { fontFamily: "original", fontSize: 13, lineHeight: 1.15 },
  } as Terminal;
  let size = "";
  const style = vi.spyOn(globalThis, "getComputedStyle").mockImplementation(
    () =>
      ({
        fontFamily: "original",
        color: "rgb(1, 2, 3)",
        getPropertyValue: (key: string) => (key === "--appearance-mono-size" ? size : ""),
      }) as CSSStyleDeclaration,
  );
  const frames = vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation((callback) => {
    callback(0);
    return 1;
  });
  const fit = vi.fn();
  const stop = observeTerminalAppearance(terminal, element, fit);
  try {
    window.dispatchEvent(new Event(APPEARANCE_CHANGED));
    expect(terminal.options.theme?.background).toBe("rgb(1, 2, 3)");
    expect(fit).not.toHaveBeenCalled();
    size = "17px";
    window.dispatchEvent(new Event(APPEARANCE_CHANGED));
    expect(terminal.options.fontSize).toBe(17);
    expect(fit).toHaveBeenCalledTimes(1);
    size = "";
    window.dispatchEvent(new Event(APPEARANCE_CHANGED));
    expect(terminal.options.fontSize).toBe(13);
    stop();
    size = "19px";
    window.dispatchEvent(new Event(APPEARANCE_CHANGED));
    expect(terminal.options.fontSize).toBe(13);
  } finally {
    stop();
    element.remove();
    style.mockRestore();
    frames.mockRestore();
  }
});
