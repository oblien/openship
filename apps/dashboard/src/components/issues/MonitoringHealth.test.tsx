// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/components/i18n-provider";
import type { MonitoringHealthSnapshot } from "@/lib/api/issues";
import { MonitoringHealth } from "./MonitoringHealth";

const mocks = vi.hoisted(() => ({
  health: vi.fn(),
  update: vi.fn(),
  scan: vi.fn(),
  toast: vi.fn(),
  org: "org-one",
}));
vi.mock("@/lib/api", () => ({
  issuesApi: { health: mocks.health, scanHealth: mocks.scan },
  jobsApi: { update: mocks.update },
  getApiErrorMessage: (error: Error, fallback: string) => error.message || fallback,
}));
vi.mock("@/lib/api/client", () => ({ getActiveOrganizationId: () => mocks.org }));
vi.mock("@/components/toast", () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock("recharts", () => {
  const Empty = () => null;
  return {
    Bar: Empty,
    BarChart: Empty,
    Cell: Empty,
    Pie: Empty,
    PieChart: Empty,
    ResponsiveContainer: Empty,
    Tooltip: Empty,
    XAxis: Empty,
    YAxis: Empty,
  };
});

let snapshot: MonitoringHealthSnapshot;
let root: Root;
let container: HTMLDivElement;
const base = (): MonitoringHealthSnapshot => ({
  data: [],
  watching: false,
  capabilities: { current: true, continuous: true },
  currentScan: null,
  watcher: {
    key: "services:health-watch",
    schedule: "* * * * *",
    available: true,
    eventsEnabled: false,
    canManage: true,
    runsWhileAppOpen: true,
  },
});
const button = (text: string) =>
  [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === text);
const render = () =>
  act(async () => {
    root.render(
      <I18nProvider>
        <MonitoringHealth />
      </I18nProvider>,
    );
  });
const click = (text: string) =>
  act(async () => {
    expect(button(text)).toBeDefined();
    button(text)!.click();
  });

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  mocks.org = "org-one";
  snapshot = base();
  mocks.health.mockReset().mockImplementation(async () => structuredClone(snapshot));
  mocks.update.mockReset().mockImplementation(async (_key, patch) => {
    snapshot.watching = patch.enabled;
    return {};
  });
  mocks.scan.mockReset();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("automatic monitoring controls", () => {
  it("only reads the snapshot on entry and enables/disables the existing job on request", async () => {
    await render();
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.scan).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Keep Openship running");
    expect(container.textContent).toContain("Cloud workloads are excluded");
    const details = container.querySelector("details")!;
    expect(details.open).toBe(false);
    await act(async () => details.querySelector("summary")!.click());
    expect(details.open).toBe(true);
    await click("Enable monitoring");
    expect(mocks.update).toHaveBeenLastCalledWith("services:health-watch", { enabled: true });
    expect(button("Disable monitoring")).toBeDefined();
    expect(container.textContent).toContain("Failures and recovery are tracked in Issues");
    expect(mocks.scan).not.toHaveBeenCalled();
    await click("Disable monitoring");
    expect(mocks.update).toHaveBeenLastCalledWith("services:health-watch", { enabled: false });
    expect(button("Enable monitoring")).toBeDefined();
  });

  it("shows a failed enable without pretending monitoring is active", async () => {
    mocks.update.mockRejectedValue(new Error("Could not save the schedule"));
    await render();
    await click("Enable monitoring");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Could not save the schedule",
    );
    expect(button("Disable monitoring")).toBeUndefined();
    expect(button("Enable monitoring")).toBeDefined();
  });

  it("does not offer instance-wide mutations to a reader", async () => {
    snapshot.watcher.canManage = false;
    await render();
    expect(button("Enable monitoring")).toBeUndefined();
    expect(container.textContent).toContain("An instance administrator");
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("explains an unavailable worker instead of hiding the monitoring option", async () => {
    snapshot.capabilities.continuous = false;
    snapshot.watcher.available = false;
    snapshot.watcher.canManage = false;
    await render();
    expect(container.textContent).toContain("Background jobs are disabled");
    expect(button("Enable monitoring")).toBeUndefined();
  });

  it("refreshes a manual snapshot without enabling automatic monitoring", async () => {
    const completedAt = new Date().toISOString();
    const result = {
      completedAt,
      summary: {
        servers: 1,
        projects: 1,
        workloads: 1,
        opened: 0,
        escalated: 0,
        resolved: 0,
        stale: 0,
        unreachable: 0,
        unresolved: 0,
        skipped: 0,
        indeterminate: 0,
        pending: 0,
        recovering: 0,
        errors: 0,
      },
    };
    mocks.scan.mockImplementation(async () => {
      snapshot.currentScan = result;
      snapshot.data = [
        {
          projectId: "p1",
          projectName: "Project",
          projectSlug: "project",
          serviceId: "s1",
          serviceKey: "s1",
          serviceName: "Worker",
          serverId: "host",
          serverName: "Host",
          containerId: "c1",
          state: "healthy",
          observedAt: completedAt,
        },
      ];
      return { data: result };
    });
    await render();
    await click("Check now");
    expect(mocks.scan).toHaveBeenCalledOnce();
    expect(mocks.update).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Healthy at last check");
    expect(container.textContent).toContain("On demand");
    expect(button("Enable monitoring")).toBeDefined();
    expect(button("Disable monitoring")).toBeUndefined();
  });
});

describe("cached monitoring reads", () => {
  it("skips hidden tabs and overlapping reads, and refreshes on return", async () => {
    let resolve!: (value: MonitoringHealthSnapshot) => void;
    mocks.health.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    await render();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(45_000);
    });
    expect(mocks.health).toHaveBeenCalledTimes(1);
    await act(async () => resolve(snapshot));
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(mocks.health).toHaveBeenCalledTimes(1);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(mocks.health).toHaveBeenCalledTimes(2);
  });

  it("discards responses from the previous workspace", async () => {
    let resolve!: (value: MonitoringHealthSnapshot) => void;
    mocks.health.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    await render();
    mocks.org = "org-two";
    snapshot.watching = true;
    await act(async () => resolve(snapshot));
    expect(button("Disable monitoring")).toBeUndefined();
    expect(container.textContent).toContain("Loading health snapshot");
  });

  it("shows unknown coverage without reporting it as a confirmed issue", async () => {
    snapshot.watching = true;
    snapshot.data = [
      {
        projectId: "p1",
        projectName: "Project",
        projectSlug: "project",
        serviceId: "s1",
        serviceKey: "s1",
        serviceName: "Worker",
        serverId: "host",
        serverName: "Host",
        containerId: "c1",
        state: "unknown",
        observedAt: new Date().toISOString(),
      },
    ];
    await render();
    expect(container.textContent).toContain("Partial");
    expect(container.textContent).not.toContain("Healthy at last check");
    expect(container.textContent).not.toContain("1 problems");
  });

  it("uses newer automatic observations instead of stale manual-scan warnings", async () => {
    snapshot.watching = true;
    snapshot.data = [
      {
        projectId: "p1",
        projectName: "Project",
        projectSlug: "project",
        serviceId: "s1",
        serviceKey: "s1",
        serviceName: "Worker",
        serverId: "host",
        serverName: "Host",
        containerId: "c1",
        state: "healthy",
        observedAt: "2026-09-24T12:01:00.000Z",
      },
    ];
    snapshot.currentScan = {
      completedAt: "2026-09-24T12:00:00.000Z",
      summary: {
        servers: 1,
        projects: 1,
        workloads: 1,
        opened: 0,
        escalated: 0,
        resolved: 0,
        stale: 0,
        unreachable: 1,
        unresolved: 0,
        skipped: 0,
        indeterminate: 1,
        pending: 0,
        recovering: 0,
        errors: 0,
      },
    };
    await render();
    expect(container.textContent).toContain("Healthy at last check");
    expect(container.textContent).not.toContain("Current check completed with partial coverage");
  });
});
