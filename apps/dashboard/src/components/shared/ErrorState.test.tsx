// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import ErrorState from "./ErrorState";
import {
  clearProjectEndpointCaches,
  retryProjectRequests,
  useProjectInfo,
} from "@/hooks/useProjectEndpoints";

const api = vi.hoisted(() => ({ getInfo: vi.fn() }));
vi.mock("@/lib/api", async () => ({
  ...(await import("@/lib/api/client")),
  projectsApi: api,
  endpoints: {},
}));

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.resetAllMocks();
  clearProjectEndpointCaches();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  clearProjectEndpointCaches();
  vi.unstubAllGlobals();
});

function ProjectRead() {
  const { data, error, isRefreshing } = useProjectInfo("project");
  return error ? (
    <ErrorState
      type="load-failed"
      error={{ details: error }}
      retrying={isRefreshing}
      onRetry={() => retryProjectRequests("project")}
    />
  ) : (
    <p>{data?.project.name ?? "Loading project"}</p>
  );
}

it("retries the project read in place, prevents duplicate clicks, and recovers after a failed retry", async () => {
  api.getInfo.mockRejectedValueOnce(new Error("Failed to fetch"));
  await act(async () => root.render(<ProjectRead />));
  expect(container.querySelector("h1")?.textContent).toBe("Couldn't load this project");
  expect(container.querySelector('[aria-describedby] > [role="status"]')?.textContent).toContain(
    "Check your connection and try again.",
  );
  expect(container.querySelector("details")?.open).toBe(false);
  expect(container.querySelector("details")?.textContent).toContain("Failed to fetch");
  expect(container.querySelector('a[href="/projects"]')).not.toBeNull();

  let reject!: (error: Error) => void;
  api.getInfo.mockImplementationOnce(
    () =>
      new Promise((_, fail) => {
        reject = fail;
      }),
  );
  const retry = container.querySelector<HTMLButtonElement>("button")!;
  await act(async () => retry.click());
  expect(api.getInfo).toHaveBeenCalledTimes(2);
  expect(retry.disabled).toBe(true);
  expect(retry.getAttribute("aria-busy")).toBe("true");
  expect(container.querySelector("h1")?.textContent).toBe("Couldn't load this project");
  await act(async () => retry.click());
  expect(api.getInfo).toHaveBeenCalledTimes(2);

  await act(async () => reject(new Error("The request timed out")));
  expect(retry.disabled).toBe(false);
  expect(container.querySelector("details")?.textContent).toContain("The request timed out");
  api.getInfo.mockResolvedValue({ success: true, data: { project: { name: "Storefront" } } });
  await act(async () => retry.click());
  expect(container.textContent).toBe("Storefront");
  expect(api.getInfo).toHaveBeenCalledTimes(3);
  expect(api.getInfo).toHaveBeenLastCalledWith("project");
});

it.each([
  { type: "project-not-found" as const, title: "Project Not Found", href: "/projects" },
  { type: "access-denied" as const, title: "Access Denied", href: "/projects" },
  { type: "repo-not-found" as const, title: "Repository Not Found", href: "/library" },
])("keeps $type distinct from a retryable connection failure", async ({ type, title, href }) => {
  const retry = vi.fn();
  await act(async () => root.render(<ErrorState type={type} onRetry={retry} />));
  expect(container.querySelector("h1")?.textContent).toBe(title);
  expect(container.querySelector(`a[href="${href}"]`)).not.toBeNull();
  expect(container.querySelector("button")).toBeNull();
  expect(container.querySelector("details")?.open).toBe(false);
  expect(retry).not.toHaveBeenCalled();
});
