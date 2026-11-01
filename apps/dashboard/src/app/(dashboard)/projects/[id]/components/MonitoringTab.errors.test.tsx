// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/components/i18n-provider";
import { clearProjectEndpointCaches } from "@/hooks/useProjectEndpoints";
import { mockGeo, mockSingleUsage } from "@/components/monitoring/fixtures";
import { MonitoringTab } from "./MonitoringTab";

const h = vi.hoisted(() => ({
  get: vi.fn(),
  id: "",
  deployMode: "selfhosted",
  usage: null as unknown,
}));
vi.mock("@/lib/api", () => ({
  api: { get: h.get },
  projectsApi: {},
  ApiError: class extends Error {},
  endpoints: {
    analytics: {
      overview: "/analytics/overview",
      geo: "/analytics/geo",
      usageHistory: "/analytics/usage/history",
    },
  },
}));
vi.mock("@/context/ProjectSettingsContext", () => ({
  useProjectSettings: () => ({
    id: h.id,
    domain: "app.example.com",
    projectData: { domains: [{ domain: "app.example.com" }] },
  }),
}));
vi.mock("@/context/PlatformContext", () => ({ usePlatform: () => ({ deployMode: h.deployMode }) }));
vi.mock("@/hooks/useProjectUsageStream", () => ({
  useProjectUsageStream: () => ({
    usage: h.usage,
    isConnected: true,
    isConnecting: false,
    error: null,
    reconnect: vi.fn(),
  }),
}));
vi.mock("@/hooks/useRequestLogStream", () => ({
  useRequestLogStream: () => ({ reconnect: vi.fn() }),
}));

type Source = "overview" | "geo" | "history";
const sourceOf = (path: string): Source =>
  path.endsWith("overview") ? "overview" : path.endsWith("geo") ? "geo" : "history";
const responses = {
  overview: {
    data: {
      summary: {
        totalRequests: 640,
        pageRequests: 600,
        uniqueVisitors: 34,
        bandwidthIn: 10,
        bandwidthOut: 20,
        avgResponseTimeMs: 12,
        lastUpdated: null,
      },
      periods: [],
    },
  },
  geo: { data: mockGeo() },
  history: { data: { buckets: [], services: [], granularityMinutes: 5, serviceKey: null } },
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
let root: Root;
let element: HTMLDivElement;
let serial = 0;
let failures: Partial<Record<Source, Error>>;
async function render() {
  await act(async () =>
    root.render(
      <I18nProvider>
        <MonitoringTab />
      </I18nProvider>,
    ),
  );
}
function retry() {
  return element.querySelector<HTMLButtonElement>('[role="alert"] button')!;
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  localStorage.clear();
  clearProjectEndpointCaches();
  h.id = `monitoring-errors-${++serial}`;
  h.deployMode = "selfhosted";
  h.usage = mockSingleUsage;
  failures = {};
  h.get.mockReset().mockImplementation(async (path: string) => {
    const source = sourceOf(path);
    if (failures[source]) throw failures[source];
    return responses[source];
  });
  element = document.createElement("div");
  document.body.appendChild(element);
  root = createRoot(element);
});
afterEach(async () => {
  await act(async () => root.unmount());
  element.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("project monitoring request failures", () => {
  it("shows one retryable failure when opening offline, without reporting empty traffic or history", async () => {
    failures = {
      overview: new TypeError("Failed to fetch"),
      geo: new TypeError("Failed to fetch"),
      history: new TypeError("Failed to fetch"),
    };
    await render();
    expect(element.querySelectorAll('[role="alert"]')).toHaveLength(1);
    expect(element.textContent).not.toContain("No monitoring data yet");
    expect(element.textContent).not.toContain("No country data for this period yet");
    expect(element.textContent).not.toContain("No usage history yet");
    const pending = deferred<(typeof responses)[Source]>();
    h.get.mockImplementation(() => pending.promise);
    await act(async () => retry().click());
    expect(retry().disabled).toBe(true);
    await act(async () => retry().click());
    expect(h.get).toHaveBeenCalledTimes(6);
    // Failed requests remain retryable when the next attempt also loses the connection.
    await act(async () => pending.reject(new TypeError("Connection lost again")));
    expect(retry().disabled).toBe(false);
    expect(element.textContent).toContain("Connection lost again");
  });

  it.each(["overview", "geo", "history"] as const)(
    "retries a failed %s read without refetching healthy endpoints",
    async (source) => {
      failures[source] = new DOMException("Request timed out", "AbortError");
      await render();
      expect(element.querySelector('[role="alert"]')?.textContent).toContain("Request timed out");
      delete failures[source];
      await act(async () => retry().click());
      expect(
        h.get.mock.calls.map(([path]) => sourceOf(path)).filter((key) => key === source),
      ).toHaveLength(2);
      expect(h.get).toHaveBeenCalledTimes(4);
      expect(element.querySelector('[role="alert"]')).toBeNull();
      expect(element.textContent).toContain("640");
      expect(element.textContent).toContain("United States");
    },
  );

  it("retains last-known geography after a poll and a manual retry both fail", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    await render();
    failures.geo = new TypeError("Connection lost");
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(element.textContent).toContain("United States");
    expect(element.querySelector('[role="alert"]')?.textContent).toContain("last available data");
    await act(async () => retry().click());
    expect(element.textContent).toContain("United States");
    expect(element.textContent).not.toContain("No country data for this period yet");
    expect(retry().disabled).toBe(false);
  });

  it("does not request unsupported history on Desktop", async () => {
    h.deployMode = "desktop";
    await render();
    expect(h.get.mock.calls.map(([path]) => sourceOf(path))).toEqual(["overview", "geo"]);
  });
});
