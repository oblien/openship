// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { navigateToCheckout } from "./checkout-navigation";

afterEach(() => vi.restoreAllMocks());

it.each(["javascript:alert(1)", "data:text/html,checkout", "http://checkout.example.test", ""])(
  "refuses an invalid payment destination before opening a tab: %s", value => {
    const open = vi.spyOn(window, "open");
    const before = window.location.href;
    expect(() => navigateToCheckout(value, true)).toThrow();
    expect(open).not.toHaveBeenCalled();
    expect(window.location.href).toBe(before);
  },
);

it("opens only the final URL without an opener or referrer, preserving the project", () => {
  const open = vi.spyOn(window, "open").mockReturnValue(null);
  const before = window.location.href;
  expect(navigateToCheckout("https://checkout.example.test/session", true)).toBe("https://checkout.example.test/session");
  expect(open).toHaveBeenCalledExactlyOnceWith("https://checkout.example.test/session", "_blank", "noopener,noreferrer");
  expect(window.location.href).toBe(before);
});

it("retains the validated fallback URL if the browser throws when refusing a popup", () => {
  vi.spyOn(window, "open").mockImplementation(() => { throw new Error("Popups refused"); });
  expect(navigateToCheckout("https://checkout.example.test/session", true)).toBe("https://checkout.example.test/session");
});

it("uses the existing tab when there is no project draft to preserve", () => {
  const open = vi.spyOn(window, "open");
  navigateToCheckout("https://checkout.example.test/session", false);
  expect(window.location.href).toBe("https://checkout.example.test/session");
  expect(open).not.toHaveBeenCalled();
});
