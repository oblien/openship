// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/components/i18n-provider";
import { ProjectSettingsProvider, useProjectSettings } from "@/context/ProjectSettingsContext";
import { OverviewTab } from "@/app/(dashboard)/projects/[id]/components/OverviewTab";
import { invalidateProjectCaches, mapAnalyticsData, useAnalyticsOverview, useProjectUsageHistory } from "./useProjectEndpoints";

const h = vi.hoisted(() => ({ get: vi.fn(), info: vi.fn(), services: vi.fn(), router: { replace: vi.fn() } }));
vi.mock("@/lib/api", () => ({
  api: { get: h.get }, projectsApi: { getInfo: h.info }, servicesApi: { list: h.services },
  endpoints: { analytics: { overview: "/analytics/overview", usageHistory: "/analytics/usage/history" } },
  ApiError: class extends Error {},
}));
vi.mock("next/navigation", () => ({ useRouter: () => h.router }));
vi.mock("@/context/PlatformContext", () => ({ usePlatform: () => ({ isServerHost: true }) }));
vi.mock("@/app/(dashboard)/projects/[id]/components/ConnectionCard", () => ({ ConnectionCard: () => null }));
vi.mock("@/app/(dashboard)/projects/[id]/components/ConnectedServicesCard", () => ({ ConnectedServicesCard: () => null }));
vi.mock("@/app/(dashboard)/projects/[id]/components/UsedByCard", () => ({ UsedByCard: () => null }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
const response = (totalRequests: number) => ({ data: {
  summary: {
    totalRequests, pageRequests: totalRequests, uniqueVisitors: 3,
    bandwidthIn: 50, bandwidthOut: 100, avgResponseTimeMs: 15, lastUpdated: null,
  }, periods: [],
} });
function project(id: string, domains = ["primary.example.com", "second.example.com"]) {
  return {
    id, name: id, slug: id, description: "", framework: "docker",
    hasServer: true, workloadType: "web" as const, deployTarget: "server" as const,
    domains: domains.map((domain, i) => ({ domain, primary: i === 0 })),
  };
}
let serial = 0;
let id: string;
let root: Root;
let container: HTMLDivElement;
let settings: ReturnType<typeof useProjectSettings>;
function SelectionProbe() {
  settings = useProjectSettings();
  return <output data-selection>{settings.selectedDomain}</output>;
}
async function renderProject(projectId = id, initial = false) {
  await act(async () => root.render(
    <I18nProvider>
      <ProjectSettingsProvider id={projectId} initialProjectData={initial ? project(projectId) : undefined}>
        <SelectionProbe />
        <OverviewTab />
      </ProjectSettingsProvider>
    </I18nProvider>,
  ));
}
function Subscriber({ projectId }: { projectId: string }) {
  const result = useAnalyticsOverview(projectId, "primary.example.com");
  return <><output data-subscriber>{result.data?.summary.totalRequests ?? "loading"}</output><output data-error>{result.error}</output></>;
}
async function renderSubscribers(count: number) {
  await act(async () => root.render(<>{Array.from({ length: count }, (_, i) =>
    <Subscriber key={i} projectId={id} />)}</>));
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  id = `analytics-${++serial}`;
  h.info.mockReset().mockImplementation(async (id: string) => ({ success: true, data: { project: project(id) } }));
  h.get.mockReset().mockResolvedValue(response(3057));
  h.services.mockReset().mockResolvedValue({ success: true, services: [] });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("project analytics requests and recovery (#396)", () => {
  it.each([false, true])("counts all project domains in one first request (initial project present: %s)", async (initial) => {
    await renderProject(id, initial);
    expect(h.get).toHaveBeenCalledOnce();
    expect(h.get).toHaveBeenCalledWith("/analytics/overview", {
      params: { projectId: id }, timeout: 60_000,
    });
    expect(container.textContent).toContain("3.1K");
  });

  it("does not fetch traffic for a project with no domain", async () => {
    h.info.mockResolvedValue({ success: true, data: { project: project(id, []) } });
    await renderProject();
    expect(h.get).not.toHaveBeenCalled();
  });

  it("keeps Overview project-wide when a different domain is selected for links", async () => {
    await renderProject();
    await act(async () => settings.setSelectedDomain("second.example.com"));
    expect(h.get).toHaveBeenCalledOnce();
    await act(async () => settings.setProjectData((p) => ({ ...p, name: "renamed" })));
    expect(settings.selectedDomain).toBe("second.example.com");
    await act(async () => settings.setProjectData((p) => ({
      ...p, domains: [{ domain: "primary.example.com", primary: true }],
    })));
    expect(settings.selectedDomain).toBe("primary.example.com");
    expect(h.get.mock.calls.every(([, options]) => !options.params.domain)).toBe(true);
  });

  it("does not carry one project's selected domain into another project's request", async () => {
    await renderProject();
    await act(async () => settings.setSelectedDomain("second.example.com"));
    const nextId = `${id}-next`;
    h.info.mockResolvedValue({ success: true, data: { project: project(nextId, ["next.example.com"]) } });
    await renderProject(nextId);
    const requests = h.get.mock.calls.filter(([, options]) => options.params.projectId === nextId);
    expect(requests.map(([, options]) => options.params.domain)).toEqual([undefined]);
  });

  it("shows a failure instead of zero traffic and retries without remounting the page", async () => {
    h.get.mockRejectedValueOnce(new DOMException("Analytics request timed out", "AbortError"));
    await renderProject();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Analytics request timed out");
    expect(container.textContent).not.toContain("No traffic data yet");
    const retry = container.querySelector<HTMLButtonElement>('[role="alert"] button')!;
    await act(async () => retry.click());
    expect(h.get).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.textContent).toContain("3.1K");
  });

  it.each(["resolve", "reject"] as const)("does not let an invalidated request %s over a newer cache entry", async (outcome) => {
    const old = deferred<ReturnType<typeof response>>();
    const fresh = deferred<ReturnType<typeof response>>();
    h.get.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
    await renderSubscribers(2);
    expect(h.get).toHaveBeenCalledOnce();
    await act(async () => invalidateProjectCaches(id));
    expect(h.get).toHaveBeenCalledTimes(2);
    await act(async () => fresh.resolve(response(200)));
    await act(async () => {
      if (outcome === "resolve") old.resolve(response(100));
      else old.reject(new DOMException("old timeout", "AbortError"));
    });
    await renderSubscribers(3);
    expect(h.get).toHaveBeenCalledTimes(2);
    expect([...container.querySelectorAll('[data-subscriber]')].map((e) => e.textContent))
      .toEqual(["200", "200", "200"]);
  });

  it("shares each minute refresh between subscribers and updates both without remounting", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    await renderSubscribers(2);
    h.get.mockResolvedValue(response(4000));
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(h.get).toHaveBeenCalledTimes(2);
    expect([...container.querySelectorAll('[data-subscriber]')].map((e) => e.textContent))
      .toEqual(["4000", "4000"]);
  });

  it("does not overlap slow polls or replace visible data with a loading state", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    await renderSubscribers(2);
    const pending = deferred<ReturnType<typeof response>>();
    h.get.mockReturnValue(pending.promise);
    await act(async () => vi.advanceTimersByTimeAsync(180_000));
    expect(h.get).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[data-subscriber]')?.textContent).toBe("3057");
    await act(async () => pending.resolve(response(4000)));
    expect(container.querySelector('[data-subscriber]')?.textContent).toBe("4000");
  });

  it("refreshes an expired cache when returning to the tab", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    await renderSubscribers(1);
    await renderSubscribers(0);
    await act(async () => vi.advanceTimersByTimeAsync(120_000));
    h.get.mockResolvedValue(response(6000));
    await renderSubscribers(1);
    expect(h.get).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[data-subscriber]')?.textContent).toBe("6000");
  });

  it("skips hidden-window polling and refreshes on becoming visible", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    await renderSubscribers(1);
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    await act(async () => vi.advanceTimersByTimeAsync(180_000));
    expect(h.get).toHaveBeenCalledOnce();
    visibility.mockReturnValue("visible");
    h.get.mockResolvedValue(response(7000));
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    expect(h.get).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[data-subscriber]')?.textContent).toBe("7000");
  });

  it("reports a failed refresh and recovers on the next poll", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    await renderSubscribers(1);
    h.get.mockRejectedValueOnce(new Error("edge unavailable"));
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(container.querySelector('[data-error]')?.textContent).toBe("edge unavailable");
    h.get.mockResolvedValue(response(9000));
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(container.querySelector('[data-error]')?.textContent).toBe("");
    expect(container.querySelector('[data-subscriber]')?.textContent).toBe("9000");
  });
});


it("prevents an older resource poll from undoing an explicit refresh (#396)", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  const history = (minute: number) => ({ data: { buckets: [{ minute }], services: [], granularityMinutes: 5 } });
  const oldPoll = deferred<ReturnType<typeof history>>();
  h.get.mockResolvedValueOnce(history(1)).mockReturnValueOnce(oldPoll.promise).mockResolvedValue(history(3));
  function History() {
    const result = useProjectUsageHistory(id, null, 1000);
    return <output data-history>{result.data?.buckets[0]?.minute}</output>;
  }
  await act(async () => root.render(<History />));
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  await act(async () => invalidateProjectCaches(id));
  expect(container.querySelector('[data-history]')?.textContent).toBe("3");
  await act(async () => oldPoll.resolve(history(2)));
  expect(container.querySelector('[data-history]')?.textContent).toBe("3");
  expect(h.get).toHaveBeenCalledTimes(3);
});

it("preserves full hourly intervals across midnight and sorts them chronologically", () => {
  const period = (from: string, to: string, requests: number) => ({
    from, to, requests, uniqueVisitors: 0, bandwidthIn: 0, bandwidthOut: 0, avgResponseTimeMs: 0,
  });
  const periods = [
    period("2026-09-25T00:00:00Z", "2026-09-25T01:00:00Z", 7),
    period("2026-09-24T23:00:00Z", "2026-09-25T00:00:00Z", 5),
  ];
  const result = mapAnalyticsData(response(12).data.summary, periods, "");
  expect(result?.trafficByHour).toEqual([periods[1], periods[0]].map(({ from, to, requests }) => ({ from, to, requests })));
  expect(result?.summary.timeRangeHours).toBe(2);
  expect(result?.summary.avgRequestsPerHour).toBe(6);
});
