// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createTheme, defaultAppearance } from "@repo/core";
import { ThemeProvider, useTheme } from "../theme-provider";
import { I18nProvider } from "../i18n-provider";
import { AppearanceEditor } from "./AppearanceEditor";
const m = vi.hoisted(() => ({ user: "alice", get: vi.fn(), set: vi.fn() }));
vi.mock("@/context/AuthContext", () => ({
  useAuth: () => ({ user: { id: m.user }, isLoading: false }),
}));
vi.mock("@/lib/api/settings", () => ({
  settingsApi: { getAppearance: m.get, setAppearance: m.set },
}));
vi.mock("@/lib/api/client", () => ({
  getApiBaseUrl: () => "https://instance.test/api/",
  getApiErrorMessage: (error: Error) => error.message,
}));
let host: HTMLDivElement;
let root: Root;
let context: ReturnType<typeof useTheme>;
function Probe() {
  context = useTheme();
  return null;
}
function tree() {
  return (
    <ThemeProvider>
      <I18nProvider>
        <Probe />
        <AppearanceEditor />
      </I18nProvider>
    </ThemeProvider>
  );
}
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}
function button(label: string) {
  const scope = document.querySelector('[role="dialog"]') ?? host;
  const found = [...scope.querySelectorAll("button")].find(
    (item) => item.textContent?.trim() === label,
  );
  if (!found) throw new Error(`Missing button ${label}`);
  return found as HTMLButtonElement;
}
async function click(label: string) {
  await act(async () => button(label).click());
  await settle();
}
async function input(selector: string, value: string) {
  const element = document.querySelector(selector) as HTMLInputElement | HTMLTextAreaElement;
  if (!element) throw new Error(`Missing ${selector}`);
  await act(async () => {
    const prototype =
      element.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await settle();
}
beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  m.user = "alice";
  m.get.mockResolvedValue({ appearance: null });
  m.set.mockResolvedValue({ appearance: null });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: false, addEventListener() {}, removeEventListener() {} })),
  );
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
it("previews a token immediately, saves only on request and discards to the saved value", async () => {
  await act(async () => root.render(tree()));
  await settle();
  await input('input[id="appearance---th-bg-page"]', "#123456");
  expect(document.documentElement.style.getPropertyValue("--th-bg-page")).toBe("#123456");
  expect(m.set).not.toHaveBeenCalled();
  await click("Save");
  expect(m.set).toHaveBeenCalledTimes(1);
  expect(m.set.mock.calls[0][0].themes[0].tokens["--th-bg-page"]).toBe("#123456");
  await input('input[id="appearance---th-bg-page"]', "#654321");
  await click("Discard");
  expect(document.documentElement.style.getPropertyValue("--th-bg-page")).toBe("#123456");
});
it("keeps malformed input editable without applying it or enabling Save", async () => {
  await act(async () => root.render(tree()));
  await settle();
  await input('input[id="appearance---th-bg-page"]', "url(https://bad.test)");
  expect(button("Save").disabled).toBe(true);
  expect(host.querySelector('[aria-invalid="true"]')).not.toBeNull();
  expect(document.documentElement.style.getPropertyValue("--th-bg-page")).not.toContain("bad.test");
  expect(m.set).not.toHaveBeenCalled();
});
it("imports portable JSON into a draft, reports failures, and preserves it after a failed save", async () => {
  await act(async () => root.render(tree()));
  await settle();
  await click("Import");
  await input("textarea", "{ invalid json");
  await click("Import");
  expect(document.querySelector('[role="alert"]')).not.toBeNull();
  const theme = createTheme("dim", "imported", "Imported theme");
  theme.tokens["--th-bg-page"] = "#234567";
  await input("textarea", JSON.stringify(theme));
  await click("Import");
  expect(document.documentElement.style.getPropertyValue("--th-bg-page")).toBe("#234567");
  expect(m.set).not.toHaveBeenCalled();
  m.set.mockRejectedValueOnce(new Error("Save failed; try again"));
  await click("Save");
  expect(host.textContent).toContain("Save failed; try again");
  expect(document.documentElement.style.getPropertyValue("--th-bg-page")).toBe("#234567");
  expect(button("Save").disabled).toBe(false);
  await click("Save");
  expect(m.set).toHaveBeenCalledTimes(2);
});
it("blocks saves after a failed read and loads on retry without replacing server data", async () => {
  m.get.mockRejectedValueOnce(new Error("Settings unavailable"));
  await act(async () => root.render(tree()));
  await settle();
  await input('input[id="appearance---th-bg-page"]', "#345678");
  expect(button("Save").disabled).toBe(true);
  m.get.mockResolvedValueOnce({ appearance: defaultAppearance("dark") });
  await click("Try again");
  expect(button("Save").disabled).toBe(false);
  expect(m.set).not.toHaveBeenCalled();
});
it("ignores a late save from the previous account", async () => {
  let finish!: () => void;
  m.set.mockReturnValueOnce(
    new Promise<void>((resolve) => {
      finish = resolve;
    }),
  );
  await act(async () => root.render(tree()));
  await settle();
  await click("New theme");
  await act(async () => button("Save").click());
  m.user = "bob";
  m.get.mockResolvedValue({ appearance: defaultAppearance("dark") });
  await act(async () => root.render(tree()));
  await settle();
  await act(async () => finish());
  await settle();
  expect(context.preferences.active).toBe("dark");
  expect(context.preferences.themes).toEqual([]);
  expect(host.textContent).not.toContain("Previewing unsaved changes.");
});
it("honors an API reset instead of restoring a cached custom theme", async () => {
  const theme = createTheme("dim", "cached", "Cached");
  localStorage.setItem(
    "openship-appearance-v1:https://instance.test/api/:alice",
    JSON.stringify({ ...defaultAppearance("cached"), themes: [theme] }),
  );
  m.get.mockResolvedValue({ appearance: null });
  await act(async () => root.render(tree()));
  await settle();
  expect(context.preferences.active).toBe("light");
  expect(context.preferences.themes).toEqual([]);
});
it("restores the saved appearance when a preset selection returns to the saved value", async () => {
  await act(async () => root.render(tree()));
  await settle();
  await click("Dark");
  expect(document.documentElement.dataset.theme).toBe("dark");
  await click("Light");
  expect(document.documentElement.dataset.theme).toBe("light");
  expect(button("Save").disabled).toBe(true);
  expect(m.set).not.toHaveBeenCalled();
});
