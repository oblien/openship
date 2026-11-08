// @vitest-environment happy-dom

import { act, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { baseDictionary } from "@/i18n";
import { DeploymentsContent } from "./DeploymentsContent";
import { CloudResourceContext } from "@/context/CloudResourceContext";

const h = vi.hoisted(() => ({ project: vi.fn(), all: vi.fn() }));
const navigationListeners = new Set<() => void>();
vi.mock("next/navigation", () => ({
  usePathname: () => window.location.pathname,
  useSearchParams: () => new URLSearchParams(useSyncExternalStore(
    listener => { navigationListeners.add(listener); return () => { navigationListeners.delete(listener); }; },
    () => window.location.search,
    () => "",
  )),
}));
vi.mock("@/lib/api", () => ({
  projectsApi: { getDeployments: h.project },
  deployApi: { getAll: h.all },
  getApiErrorMessage: (err: Error) => err.message,
}));
vi.mock("@/components/i18n-provider", () => ({
  useI18n: () => ({ t: baseDictionary }),
  interpolate: (text: string, values: Record<string, string>) => text.replace(/\{(\w+)\}/g, (_, key) => values[key] ?? key),
}));
vi.mock("./DeploymentMenu", () => ({ DeploymentMenu: () => null }));
vi.mock("./CommitDetailsModal", () => ({ CommitDetailsModal: () => null }));

function pageResponse(page = 1, total = 45, projectId = "project") {
  return {
    page, perPage: 20, total,
    data: Array.from({ length: Math.max(0, Math.min(20, total - (page - 1) * 20)) }, (_, offset) => {
      const index = total - (page - 1) * 20 - offset;
      return {
        id: `dep-${projectId}-${index}`, projectId, projectName: projectId,
        status: "ready", commitMessage: `Release ${index}`, commitSha: `commit-${index}`,
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
        isActive: index === total, artifactRetainedAt: index >= total - 5 ? new Date().toISOString() : null,
      };
    }),
  };
}

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  window.history.replaceState(null, "", "/deployments");
  const replace = window.history.replaceState.bind(window.history);
  vi.spyOn(window.history, "replaceState").mockImplementation((data, unused, url) => {
    replace(data, unused, url);
    for (const listener of navigationListeners) listener();
  });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  h.project.mockReset().mockImplementation(async (id, params) => pageResponse(params?.page, 45, id));
  h.all.mockReset().mockImplementation(async (params) => pageResponse(params?.page));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function render(projectId: string | undefined = "project") {
  await act(async () => root.render(<DeploymentsContent projectId={projectId} hideHeader hideSidebar />));
}
function button(label: string) {
  const node = [...container.querySelectorAll("button")].find((node) => node.getAttribute("aria-label") === label || node.textContent === label);
  expect(node, label).toBeDefined();
  return node!;
}
const click = async (label: string) => act(async () => button(label).click());

it("navigates every project page, including the last partial page", async () => {
  await render();
  expect(container.textContent).toContain("1–20 of 45 deployments");
  expect(button("Previous page").disabled).toBe(true);
  await click("Next page");
  expect(h.project.mock.lastCall?.[1]).toMatchObject({ page: 2, perPage: 20 });
  expect(container.textContent).toContain("21–40 of 45 deployments");
  expect(container.textContent).toContain("Release 25");
  expect(container.textContent).not.toContain("Release 45");
  await click("Next page");
  expect(container.textContent).toContain("41–45 of 45 deployments");
  expect(button("Next page").disabled).toBe(true);
  await click("Previous page");
  expect(container.textContent).toContain("Page 2 of 3");
});

it("shows the live release separately from the five saved snapshots", async () => {
  await render();
  const spans = [...container.querySelectorAll("span")];
  expect(spans.filter((node) => node.textContent === "Active")).toHaveLength(1);
  expect(spans.filter((node) => node.textContent === "Snapshotted")).toHaveLength(5);
});

it("requests a status filter across history and resets the page", async () => {
  await render();
  await click("Next page");
  h.project.mockResolvedValueOnce({ ...pageResponse(1, 1), data: [{ ...pageResponse(1, 1).data[0], status: "failed", commitMessage: "Older failed deployment" }] });
  await click("Failed");
  expect(h.project.mock.lastCall?.[1]).toMatchObject({ page: 1, status: "failed" });
  expect(container.textContent).toContain("Older failed deployment");
  expect(container.textContent).toContain("1–1 of 1 deployments");
});

it("searches older history through the API instead of filtering only the visible page", async () => {
  await render();
  await click("Next page");
  h.project.mockResolvedValueOnce({ ...pageResponse(1, 1), data: [{ ...pageResponse(1, 1).data[0], commitMessage: "An old matching commit" }] });
  const input = container.querySelector("input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "old matching");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 350));
  });
  expect(h.project.mock.lastCall?.[1]).toMatchObject({ page: 1, search: "old matching" });
  expect(container.textContent).toContain("An old matching commit");
});

it("returns to the last real page when history shrinks", async () => {
  await render();
  await click("Next page");
  h.project.mockResolvedValueOnce(pageResponse(3, 40)).mockResolvedValueOnce(pageResponse(2, 40));
  await click("Next page");
  expect(h.project.mock.lastCall?.[1]).toMatchObject({ page: 2 });
  expect(container.textContent).toContain("21–40 of 40 deployments");
  expect(button("Next page").disabled).toBe(true);
});

it("aborts the previous project's request and ignores a late response", async () => {
  let finish!: (value: ReturnType<typeof pageResponse>) => void;
  h.project.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
  await render("first-project");
  const signal = h.project.mock.calls[0]![2] as AbortSignal;
  await render("second-project");
  await act(async () => finish(pageResponse(1, 45, "first-project")));
  expect(signal.aborted).toBe(true);
  expect(container.textContent).not.toContain("first-project");
  expect(container.textContent).toContain("second-project");
  expect(h.project.mock.lastCall?.[1]).toMatchObject({ page: 1 });
});

it("reports a fetch failure and allows retry instead of claiming history is empty", async () => {
  h.project.mockRejectedValueOnce(new Error("History unavailable"));
  await render();
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("History unavailable");
  expect(container.textContent).not.toContain("No deployments yet");
  await click("Try again");
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(container.textContent).toContain("1–20 of 45 deployments");
});

it("also pages global deployment history", async () => {
  await act(async () => root.render(<DeploymentsContent hideHeader hideSidebar />));
  await click("Next page");
  expect(h.all.mock.lastCall?.[0]).toMatchObject({ page: 2, perPage: 20 });
  expect(h.project).not.toHaveBeenCalled();
});

it("refreshes history on a Cloud account change and discards the previous response", async () => {
  let finish!: (value: ReturnType<typeof pageResponse>) => void;
  h.all.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }))
    .mockResolvedValueOnce(pageResponse(1, 1, "second-account"));
  const showAccount = (account: string) => act(async () => root.render(
    <CloudResourceContext.Provider value={account}>
      <DeploymentsContent hideHeader hideSidebar />
    </CloudResourceContext.Provider>,
  ));

  await showAccount("first-account");
  const signal = h.all.mock.calls[0]![1] as AbortSignal;
  await showAccount("second-account");
  await act(async () => finish(pageResponse(1, 1, "first-account")));

  expect(signal.aborted).toBe(true);
  expect(h.all).toHaveBeenCalledTimes(2);
  expect(container.textContent).toContain("second-account");
  expect(container.textContent).not.toContain("first-account");
});

it("can select a project whose history is older than the first page", async () => {
  const projects = [{ id: "project", name: "Recent project" }, { id: "old-project", name: "Older project" }];
  h.all.mockResolvedValueOnce({ ...pageResponse(), projects });
  await act(async () => root.render(<DeploymentsContent hideHeader hideSidebar />));
  await click("All Projects");
  h.all.mockResolvedValueOnce({ ...pageResponse(1, 1, "old-project"), projects });
  await click("Older project");
  expect(h.all.mock.lastCall?.[0]).toMatchObject({ projectId: "old-project", page: 1 });
  expect(container.textContent).toContain("1–1 of 1 deployments");
  expect(container.textContent).toContain("Older project");
});

it("refreshes running rows without replacing them with skeletons, then stops polling", async () => {
  vi.useFakeTimers();
  const response = pageResponse(1, 1);
  h.project.mockResolvedValueOnce({ ...response, data: [{ ...response.data[0], status: "building", isActive: false }] });
  await render();
  expect(container.textContent).toContain("Building");
  let finish!: (value: ReturnType<typeof pageResponse>) => void;
  h.project.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
  expect(h.project).toHaveBeenCalledTimes(2);
  expect(container.textContent).toContain("Release 1");
  expect(container.textContent).toContain("Building");
  await act(async () => {
    window.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(30_000);
  });
  expect(h.project).toHaveBeenCalledTimes(2);
  await act(async () => finish(response));
  expect(container.textContent).toContain("Deployed");
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(h.project).toHaveBeenCalledTimes(2);
});

it("refreshes settled history once on return and deduplicates browser resume events", async () => {
  vi.useFakeTimers();
  await render();
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(h.project).toHaveBeenCalledTimes(1);
  const updated = pageResponse(1, 1);
  updated.data[0]!.commitMessage = "Completed while away";
  h.project.mockResolvedValueOnce(updated);
  await act(async () => {
    window.dispatchEvent(new Event("focus"));
    window.dispatchEvent(new Event("online"));
    document.dispatchEvent(new Event("visibilitychange"));
  });
  expect(h.project).toHaveBeenCalledTimes(2);
  expect(container.textContent).toContain("Completed while away");
  await act(async () => window.dispatchEvent(new Event("focus")));
  expect(h.project).toHaveBeenCalledTimes(2);
});

it("does not poll or refresh history while hidden or offline", async () => {
  vi.useFakeTimers();
  const response = pageResponse(1, 1);
  h.project.mockResolvedValueOnce({ ...response, data: [{ ...response.data[0], status: "queued" }] });
  await render();
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30_000);
    window.dispatchEvent(new Event("focus"));
  });
  expect(h.project).toHaveBeenCalledTimes(1);
  visibility.mockReturnValue("visible");
  const online = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  expect(h.project).toHaveBeenCalledTimes(1);
  online.mockReturnValue(true);
  await act(async () => window.dispatchEvent(new Event("online")));
  expect(h.project).toHaveBeenCalledTimes(2);
});
