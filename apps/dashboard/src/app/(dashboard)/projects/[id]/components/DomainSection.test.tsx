// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DomainSection } from "./DomainSection";

const state = vi.hoisted(() => ({
  query: "hostname=second.test",
  replace: vi.fn(),
  listRouteProtection: vi.fn(),
  changeRouteProtection: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: state.replace }),
  useSearchParams: () => new URLSearchParams(state.query),
}));
vi.mock("@/context/ProjectSettingsContext", () => ({
  useProjectSettings: () => ({
    projectData: {
      id: "proj",
      deployTarget: "server",
      domains: [{ domain: "first.test" }, { hostname: "second.test" }],
    },
    setProjectData: vi.fn(),
  }),
}));
vi.mock("@/lib/api", () => ({
  projectsApi: state,
  getApiErrorMessage: (_: unknown, fallback: string) => fallback,
}));
vi.mock("./RoutingConfigCard", () => ({ RoutingConfigCard: () => null }));
vi.mock("./RouteRules", () => ({ RouteRules: () => null }));
vi.mock("@/components/routing/EdgePagesPanel", () => ({ EdgePagesPanel: () => null }));

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.query = "hostname=second.test";
  state.listRouteProtection.mockResolvedValue({
    data: [{ hostname: "second.test", enabled: true, status: "applied" }],
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("opens the linked hostname inline and keeps hostname selection in the URL", async () => {
  await act(async () => root.render(<DomainSection section="access" />));
  expect(container.querySelector('[role="status"]')?.textContent).toContain(
    "Password protection is active",
  );
  expect(container.querySelector('[role="dialog"]')).toBeNull();
  const selector = container.querySelector<HTMLButtonElement>(
    'button[aria-label="Choose a hostname first"]',
  )!;
  expect(selector.textContent).toContain("second.test");
  await act(async () => selector.click());
  const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((item) =>
    item.textContent?.includes("first.test"),
  )!;
  expect(option).toBeTruthy();
  await act(async () => option.click());
  expect(state.replace).toHaveBeenCalledWith("/projects/proj/access?hostname=first.test", {
    scroll: false,
  });
});

it("clears a hostname's unfinished password when navigation selects another hostname", async () => {
  await act(async () => root.render(<DomainSection section="access" />));
  const password = container.querySelector<HTMLInputElement>('input[type="password"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
      password,
      "not-for-another-host",
    );
    password.dispatchEvent(new Event("input", { bubbles: true }));
  });
  state.query = "hostname=first.test";
  await act(async () => root.render(<DomainSection section="access" />));
  expect(container.querySelector<HTMLInputElement>('input[type="password"]')!.value).toBe("");
  expect(container.querySelector('[role="status"]')?.textContent).toContain("This route is public");
  expect(state.changeRouteProtection).not.toHaveBeenCalled();
});

it("ignores unknown hostnames in the query and selects an owned domain", async () => {
  state.query = "hostname=unowned.test";
  await act(async () => root.render(<DomainSection section="access" />));
  expect(
    container.querySelector('button[aria-label="Choose a hostname first"]')?.textContent,
  ).toContain("first.test");
  expect(container.textContent).not.toContain("unowned.test");
});
