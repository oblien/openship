// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { defaultAppearance } from "@repo/core";
import { ThemeProvider, useTheme } from "./theme-provider";

const m = vi.hoisted(() => ({ loading: true, get: vi.fn() }));
vi.mock("@/context/AuthContext", () => ({
  useAuth: () => ({ user: { id: "alice" }, isLoading: m.loading }),
}));
vi.mock("@/lib/api/settings", () => ({ settingsApi: { getAppearance: m.get } }));
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
    <ThemeProvider initialTheme={{ active: "dim", resolved: "dim" }}>
      <Probe />
    </ThemeProvider>
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  document.cookie = "openship-theme=dim:dim;path=/";
  document.documentElement.dataset.theme = "dim";
  m.loading = true;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  document.cookie = "openship-theme=;path=/;max-age=0";
  document.documentElement.removeAttribute("style");
  document.documentElement.removeAttribute("data-theme");
  vi.unstubAllGlobals();
});

it("retains the server palette while authentication and account settings load without a cache", async () => {
  let finish!: (value: { appearance: ReturnType<typeof defaultAppearance> }) => void;
  m.get.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  await act(async () => root.render(tree()));
  expect(context.resolvedTheme).toBe("dim");
  expect(m.get).not.toHaveBeenCalled();
  m.loading = false;
  await act(async () => root.render(tree()));
  expect(m.get).toHaveBeenCalledTimes(1);
  expect(document.documentElement.dataset.theme).toBe("dim");
  await act(async () => finish({ appearance: defaultAppearance("dim") }));
  expect(context.ready).toBe(true);
  expect(document.documentElement.dataset.theme).toBe("dim");
});

it("keeps unsaved previews out of the next page's server preference", async () => {
  m.loading = false;
  m.get.mockResolvedValue({ appearance: defaultAppearance("dim") });
  await act(async () => root.render(tree()));
  await act(async () => context.previewAppearance(defaultAppearance("light")));
  expect(document.documentElement.dataset.theme).toBe("light");
  expect(document.cookie).toContain("openship-theme=dim:dim");
  await act(async () => context.discardAppearance());
  expect(document.documentElement.dataset.theme).toBe("dim");
});
