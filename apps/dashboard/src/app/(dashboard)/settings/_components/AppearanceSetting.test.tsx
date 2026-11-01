// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { defaultAppearance } from "@repo/core";
import { I18nProvider } from "@/components/i18n-provider";
import { AppearanceSetting } from "./AppearanceSetting";

const m = vi.hoisted(() => ({ active: "dim", setTheme: vi.fn() }));
vi.mock("@/components/theme-provider", () => ({
  useTheme: () => ({ preferences: defaultAppearance(m.active), setTheme: m.setTheme }),
}));
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.clearAllMocks();
  m.active = "dim";
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
async function render() {
  await act(async () =>
    root.render(
      <I18nProvider>
        <AppearanceSetting />
      </I18nProvider>,
    ),
  );
}
it("retains the four immediate switches and links customization to a nested General view", async () => {
  await render();
  const radios = [...host.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
  expect(radios.map((input) => input.value)).toEqual(["light", "dim", "dark", "system"]);
  expect(radios.find((input) => input.checked)?.value).toBe("dim");
  await act(async () => radios.find((input) => input.value === "dark")!.click());
  expect(m.setTheme).toHaveBeenCalledWith("dark");
  expect(host.querySelector("a")?.getAttribute("href")).toBe(
    "/settings?tab=general&view=appearance",
  );
  expect(host.querySelector("a")?.textContent).toBe("Customize");
});
it("allows returning from a custom theme to its own base preset", async () => {
  m.active = "personal-dim";
  await render();
  expect(host.querySelector("input:checked")).toBeNull();
  await act(async () => host.querySelector<HTMLInputElement>('input[value="dim"]')!.click());
  expect(m.setTheme).toHaveBeenCalledWith("dim");
});
