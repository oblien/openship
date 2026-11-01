// @vitest-environment happy-dom
import { act, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/components/i18n-provider";
import { DeploymentsContent } from "./DeploymentsContent";

const h = vi.hoisted(() => ({ all: vi.fn(), project: vi.fn() }));
vi.mock("@/lib/api", () => ({
  deployApi: { getAll: h.all }, projectsApi: { getDeployments: h.project },
  getApiErrorMessage: (error: Error) => error.message,
}));
vi.mock("./DeploymentMenu", () => ({ DeploymentMenu: () => null }));
vi.mock("./CommitDetailsModal", () => ({ CommitDetailsModal: () => null }));

// Next integrates history.replaceState with useSearchParams. Reproduce that
// notification at the router boundary while rendering the real history UI.
const listeners = new Set<() => void>();
vi.mock("next/navigation", () => ({
  usePathname: () => window.location.pathname,
  useSearchParams: () => new URLSearchParams(useSyncExternalStore(
    listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    () => window.location.search,
    () => "",
  )),
}));

let root: Root;
let container: HTMLDivElement;
const originalReplace = window.history.replaceState.bind(window.history);
function notifyNavigation() { for (const listener of listeners) listener(); }
function navigate(query: string) {
  originalReplace(null, "", `/deployments${query}`);
  window.dispatchEvent(new PopStateEvent("popstate"));
  notifyNavigation();
}
function result(page = 1) {
  return {
    total: 50, page, perPage: 20,
    projects: [{ id: "p1", name: "alpha" }, { id: "p2", name: "beta" }],
    data: Array.from({ length: Math.min(20, 50 - (page - 1) * 20) }, (_, i) => ({
      id: `d${page}-${i}`, projectId: "p1", projectName: "alpha", status: "ready",
      commitMessage: `Release ${page}-${i}`, createdAt: "2026-08-11T10:00:00Z",
    })),
  };
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  originalReplace(null, "", "http://localhost:3000/deployments");
  vi.spyOn(window.history, "replaceState").mockImplementation((data, unused, url) => {
    originalReplace(data, unused, url);
    notifyNavigation();
  });
  h.all.mockReset().mockImplementation(async params => result(params.page));
  h.project.mockReset().mockImplementation(async (_id, params) => result(params.page));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function mount(projectId?: string, monitoring = false) {
  await act(async () => root.render(<I18nProvider><DeploymentsContent monitoring={monitoring} projectId={projectId} hideHeader hideSidebar /></I18nProvider>));
}
function button(label: string) {
  const button = [...container.querySelectorAll("button")].find(node => node.textContent?.trim().toLowerCase() === label.toLowerCase() || node.getAttribute("aria-label") === label);
  expect(button).toBeDefined();
  return button!;
}
const click = async (label: string) => act(async () => button(label).click());
async function type(value: string) {
  await act(async () => {
    const input = container.querySelector("input")!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const params = () => new URLSearchParams(window.location.search);

describe("deployment history filters survive navigation", () => {
  it("leaves an unfiltered URL unchanged", async () => {
    await mount();
    expect(window.history.replaceState).not.toHaveBeenCalled();
    expect(h.all.mock.lastCall?.[0]).toMatchObject({ page: 1, status: undefined, projectId: undefined });
  });
  it("restores project, status, search and page from a shared or Back URL", async () => {
    navigate("?project=p2&status=failed&q=release&page=2");
    await mount();
    expect(h.all.mock.lastCall?.[0]).toMatchObject({ page: 2, status: "failed", projectId: "p2", search: "release" });
    expect(container.querySelector("input")?.value).toBe("release");
    expect(button("beta")).toBeDefined();
    expect(window.history.replaceState).not.toHaveBeenCalled();
  });
  it("preserves unrelated params and the hash while resetting the page for a filter", async () => {
    navigate("?ref=email&page=2#history");
    await mount();
    await click("Failed");
    expect(params().get("status")).toBe("failed");
    expect(params().has("page")).toBe(false);
    expect(params().get("ref")).toBe("email");
    expect(window.location.hash).toBe("#history");
    expect(h.all.mock.lastCall?.[0]).toMatchObject({ page: 1, status: "failed" });
  });
  it("removes default values from the URL", async () => {
    navigate("?status=failed");
    await mount();
    await click("All");
    expect(window.location.search).toBe("");
  });
  it("uses safe defaults for an invalid status or page", async () => {
    navigate("?status=__proto__&page=-8");
    await mount();
    expect(h.all.mock.lastCall?.[0]).toMatchObject({ page: 1, status: undefined });
  });
  it("tracks browser navigation without requiring a remount", async () => {
    await mount();
    await click("Failed");
    await act(async () => navigate("?project=p2&status=success&q=older&page=2"));
    expect(h.all.mock.lastCall?.[0]).toMatchObject({ page: 2, status: "success", projectId: "p2", search: "older" });
    expect(container.querySelector("input")?.value).toBe("older");
    expect(params().get("status")).toBe("success");
  });
  it("retains both changes when filters are changed before a router render", async () => {
    await mount();
    await click("All projects");
    await act(async () => { button("beta").click(); button("Failed").click(); });
    expect(params().get("project")).toBe("p2");
    expect(params().get("status")).toBe("failed");
  });
  it("persists pagination without adding history entries", async () => {
    await mount();
    const length = window.history.length;
    await click("Next page");
    expect(params().get("page")).toBe("2");
    expect(h.all.mock.lastCall?.[0]).toMatchObject({ page: 2 });
    expect(window.history.length).toBe(length);
  });
  it("cancels a pending search when Back restores a different list", async () => {
    await mount();
    await type("unfinished");
    await act(async () => navigate("?status=failed"));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 350)); });
    expect(params().has("q")).toBe(false);
    expect(container.querySelector("input")?.value).toBe("");
    expect(h.all.mock.lastCall?.[0]).toMatchObject({ status: "failed", search: undefined });
  });
  it("keeps embedded project filters local to the project page", async () => {
    navigate("?status=failed&project=p2&q=global&page=2");
    await mount("p1");
    expect(h.project.mock.lastCall?.[1]).toMatchObject({ page: 1, status: undefined, search: undefined });
    await click("Failed");
    expect(h.project.mock.lastCall?.[1]).toMatchObject({ page: 1, status: "failed" });
    expect(window.history.replaceState).not.toHaveBeenCalled();
  });
});

it("renders unpaginated outcomes and drills down without losing the Monitoring tab", async () => {
  navigate("?tab=deployments&days=7");
  h.all.mockImplementation(async params => ({ ...result(params.page), summary: {
    days: params.days, total: 140, success: 100, failed: 25, active: 5, canceled: 10,
    avgBuildDurationMs: 12000, daily: [], projects: [{ projectId: "p2", total: 40, success: 15, failed: 25, active: 0, canceled: 0 }],
  } }));
  await mount(undefined, true);
  expect(h.all.mock.lastCall?.[0]).toMatchObject({ days: 7 });
  const overview = container.querySelector('section[aria-label="Deployment overview"]')!;
  expect(overview.textContent).toContain("140");
  expect(overview.textContent).toContain("80%");
  const active = [...overview.querySelectorAll("button")].find(b => b.textContent?.includes("In Progress"))!;
  await act(async () => active.click());
  expect(h.all.mock.lastCall?.[0]).toMatchObject({ status: "active", days: 7 });
  expect(params().get("tab")).toBe("deployments");
  await click("90 days");
  expect(h.all.mock.lastCall?.[0]).toMatchObject({ days: 90, page: 1 });
  expect(params().get("days")).toBe("90");
});
