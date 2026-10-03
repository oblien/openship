// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/components/i18n-provider";
import { setActiveOrganizationId } from "@/lib/api/client";
import type { IssueFeed } from "@/lib/api/issues";
import { IssuesView } from "./IssuesView";

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  install: vi.fn(),
  containers: vi.fn(),
  reload: vi.fn(),
  showModal: vi.fn(() => "modal"),
  hideModal: vi.fn(),
  toast: vi.fn(),
  serverIds: ["one", "two"],
  selfHosted: true,
  rescanStatus: vi.fn(),
  rescan: vi.fn(),
  deployMode: "docker",
}));
vi.mock("@/context/ModalContext", () => ({
  useModal: () => ({ showModal: mocks.showModal, hideModal: mocks.hideModal }),
}));
vi.mock("@/context/PlatformContext", () => ({
  usePlatform: () => ({ selfHosted: mocks.selfHosted, deployMode: mocks.deployMode }),
}));
vi.mock("@/components/toast", () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock("@/components/issues/MonitoringHealth", () => ({
  MonitoringHealth: () => <div>Container health content</div>,
}));
vi.mock("@/lib/api", () => ({
  getApiBaseUrl: () => "http://localhost/api/",
  getApiErrorMessage: (_: unknown, fallback: string) => fallback,
  issuesApi: { list: mocks.list, rescanStatus: mocks.rescanStatus, rescan: mocks.rescan },
  systemApi: { getInstallSession: mocks.install, listServerContainers: mocks.containers },
}));
vi.mock("@/hooks/useInfraFleet", () => ({
  useInfraFleet: () => ({
    empty: false,
    counts: {
      attention: 0,
      updates: 0,
      healthy: 0,
      stopped: 0,
      behind: 0,
      applying: mocks.serverIds.length,
    },
    active: mocks.serverIds.map((id) => ({
      serverId: id,
      serverName: id,
      component: "edge",
      state: "running",
      intent: "update",
      sessionId: `session-${id}`,
      steps: [],
    })),
    outcome: null,
    scanning: false,
    applying: "update",
    reload: mocks.reload,
  }),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function stream() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
    cancel,
  });
  return {
    response: new Response(body),
    cancel,
    send: (event: object) =>
      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`)),
    close: () => controller.close(),
  };
}
let root: Root;
let container: HTMLDivElement;
const fetcher = vi.fn();
function buttons(label: string) {
  return [...container.querySelectorAll("button")].filter((b) => b.textContent?.trim() === label);
}
async function click(label: string, index = 0) {
  const button = buttons(label)[index];
  expect(button, `Missing button: ${label}`).toBeDefined();
  await act(async () => button.click());
}
async function render() {
  await act(async () =>
    root.render(
      <I18nProvider>
        <IssuesView />
      </I18nProvider>,
    ),
  );
}
const panel = () => container.querySelector('[aria-label="Operation log"]');

beforeEach(() => {
  vi.clearAllMocks();
  fetcher.mockReset();
  mocks.serverIds = ["one", "two"];
  mocks.selfHosted = true;
  mocks.deployMode = "docker";
  mocks.rescan.mockReset();
  mocks.rescanStatus.mockReset().mockResolvedValue({ data: null });
  mocks.install.mockReset().mockResolvedValue({ active: false });
  mocks.containers.mockReset().mockResolvedValue([]);
  mocks.list.mockResolvedValue({
    data: [
      {
        id: "edge-down",
        scope: "server",
        source: "component",
        kind: "edge_down",
        severity: "outage",
        title: "server",
        message: "Edge stopped",
        resolveWith: [],
        target: { id: "one", scope: "server", name: "server", href: "/servers/one" },
        infraFix: { serverId: "one", component: "edge", action: "repair" },
      },
    ],
    counts: { total: 1, outage: 1, action_required: 0, advisory: 0 },
  });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", fetcher);
  localStorage.clear();
  setActiveOrganizationId("org-1");
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

describe("Monitoring health navigation", () => {
  it("opens Health from the Overview hint without duplicating scan controls or feed reads", async () => {
    await render();
    const reads = mocks.list.mock.calls.length;
    await click("Manage monitoring");
    expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe(
      "Health",
    );
    expect(document.activeElement?.id).toBe("monitoring-tab-health");
    expect(buttons("Manage monitoring")).toHaveLength(0);
    expect(buttons("Re-scan")).toHaveLength(0);
    expect(mocks.list).toHaveBeenCalledTimes(reads);
    await click("Overview");
    expect(buttons("Re-scan")).toHaveLength(1);
    expect(mocks.list).toHaveBeenCalledTimes(reads + 1);
  });

  it.each(["ltr", "rtl"])("supports arrow, Home and End navigation with the active tab and panel linked (%s)", async (direction) => {
    await render();
    for (const button of container.querySelectorAll<HTMLElement>('[role="tab"]')) {
      button.style.direction = direction;
    }
    const overview = container.querySelector<HTMLButtonElement>(
      '[role="tab"][aria-selected="true"]',
    )!;
    overview.focus();
    const press = (key: string) =>
      act(async () => {
        document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
      });
    await press(direction === "rtl" ? "ArrowLeft" : "ArrowRight");
    expect(document.activeElement?.id).toBe("monitoring-tab-health");
    expect(container.querySelector('[role="tabpanel"]')?.getAttribute("aria-labelledby")).toBe(
      "monitoring-tab-health",
    );
    await press("End");
    expect(document.activeElement?.textContent).toBe("History");
    await press("Home");
    expect(document.activeElement?.textContent).toBe("Overview");
    await press(direction === "rtl" ? "ArrowRight" : "ArrowLeft");
    expect(document.activeElement?.textContent).toBe("History");
    expect(container.querySelectorAll('[role="tab"][tabindex="0"]')).toHaveLength(1);
  });

  it("keeps current scans and fleet update controls in Overview when viewing History", async () => {
    await render();
    expect(buttons("View logs")).toHaveLength(1);
    mocks.list.mockResolvedValue({ data: [], counts: { total: 0, outage: 0, action_required: 0, advisory: 0 } });
    await click("History");
    expect(mocks.list).toHaveBeenLastCalledWith("resolved");
    expect(buttons("Re-scan")).toHaveLength(0);
    expect(buttons("View logs")).toHaveLength(0);
    expect(container.textContent).toContain("No resolved incidents");
    await click("Overview");
    expect(mocks.list).toHaveBeenLastCalledWith("open");
    expect(buttons("Re-scan")).toHaveLength(1);
    expect(buttons("View logs")).toHaveLength(1);
  });

  it("offers Cloud health without exposing the control-plane administrator's fleet scan", async () => {
    mocks.selfHosted = false;
    await render();
    expect(buttons("Health")).toHaveLength(1);
    expect(buttons("Manage monitoring")).toHaveLength(0);
    expect(buttons("Re-scan")).toHaveLength(0);
    expect(mocks.rescanStatus).not.toHaveBeenCalled();
    await click("Health");
    expect(container.querySelector('[role="tabpanel"]')).not.toBeNull();
    expect(mocks.install).not.toHaveBeenCalled();
  });
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  setActiveOrganizationId(null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("monitoring connection recovery", () => {
  const running = { id: "scan-1", status: "running", startedAt: "2026-09-26T00:00:00Z", stages: [{ key: "services:health-watch", status: "running" }] };
  const done = { ...running, status: "completed", stages: [{ key: "services:health-watch", status: "completed", summary: { resolved: 1, unreachable: 0 } }] };
  const emptyFeed: IssueFeed = {
    data: [],
    counts: { total: 0, outage: 0, actionRequired: 0, advisory: 0 },
    status: "open",
  };
  const recoveredFeed: IssueFeed = {
    data: [{
      id: "recovered-server", kind: "server_unreachable", severity: "action_required", scope: "server", source: "incident",
      title: "Recovered server", message: "History response has arrived", resolveWith: [], resolvedAt: "2026-09-26T00:01:00Z",
      target: { scope: "server", id: "one", name: "Recovered server", href: "/servers/one" },
    }],
    counts: { total: 1, outage: 0, actionRequired: 1, advisory: 0 },
    status: "resolved",
  };

  async function finishScanWhileFeedLoads() {
    vi.useFakeTimers();
    mocks.rescan.mockResolvedValue({ data: running });
    await render();
    await click("Re-scan");
    mocks.rescanStatus.mockResolvedValue({ data: running });
    const pending = deferred<IssueFeed>();
    mocks.list.mockReturnValueOnce(pending.promise);
    await act(async () => window.dispatchEvent(new Event("focus")));
    mocks.rescanStatus.mockResolvedValue({ data: done });
    await act(async () => vi.advanceTimersByTimeAsync(1200));
    expect(mocks.reload).toHaveBeenCalledOnce();
    return pending;
  }

  it("refreshes once after a scan completes during an existing feed read", async () => {
    const pending = await finishScanWhileFeedLoads();
    mocks.list.mockResolvedValue(emptyFeed);
    await act(async () => {
      for (let n = 0; n < 5; n++) window.dispatchEvent(new Event("focus"));
    });
    expect(mocks.list).toHaveBeenCalledTimes(2);
    await act(async () => pending.resolve(emptyFeed));
    expect(mocks.list).toHaveBeenCalledTimes(3);
    expect(container.textContent).not.toContain("Edge stopped");
    expect(mocks.reload).toHaveBeenCalledOnce();
    expect(mocks.toast).toHaveBeenCalledOnce();
  });

  it("shares the queued refresh and waits for its response before reporting completion", async () => {
    const pending = await finishScanWhileFeedLoads();
    mocks.rescan.mockResolvedValue({ data: { ...running, id: "scan-2" } });
    await click("Re-scan");
    mocks.rescanStatus.mockResolvedValue({ data: { ...done, id: "scan-2" } });
    await act(async () => vi.advanceTimersByTimeAsync(1200));
    expect(mocks.reload).toHaveBeenCalledTimes(2);

    const fresh = deferred<IssueFeed>();
    mocks.list.mockReturnValueOnce(fresh.promise);
    await act(async () => pending.resolve(emptyFeed));
    expect(mocks.list).toHaveBeenCalledTimes(3);
    expect(mocks.toast).not.toHaveBeenCalled();
    await act(async () => fresh.resolve(emptyFeed));
    expect(mocks.list).toHaveBeenCalledTimes(3);
    expect(mocks.toast).toHaveBeenCalledTimes(2);
    expect(mocks.rescan).toHaveBeenCalledTimes(2);
  });

  it("keeps History's response when an older Overview refresh was queued", async () => {
    const pendingOverview = await finishScanWhileFeedLoads();
    const pendingHistory = deferred<IssueFeed>();
    mocks.list.mockImplementation(status => status === "resolved" ? pendingHistory.promise : Promise.resolve(emptyFeed));
    await click("History");
    expect(mocks.list).toHaveBeenLastCalledWith("resolved");
    await act(async () => pendingOverview.resolve(emptyFeed));
    await act(async () => pendingHistory.resolve(recoveredFeed));
    expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe("History");
    expect(container.textContent).toContain("History response has arrived");
    expect(mocks.list).toHaveBeenCalledTimes(3);
  });

  it("discards a queued feed refresh after switching to Health", async () => {
    const pendingOverview = await finishScanWhileFeedLoads();
    await click("Health");
    await act(async () => pendingOverview.resolve(emptyFeed));
    expect(container.textContent).toContain("Container health content");
    expect(mocks.list).toHaveBeenCalledTimes(2);
  });

  it("discards an obsolete refresh after leaving and returning to Overview", async () => {
    const pendingOverview = await finishScanWhileFeedLoads();
    mocks.list.mockResolvedValue(emptyFeed);
    await click("History");
    await click("Overview");
    const reads = mocks.list.mock.calls.length;
    await act(async () => pendingOverview.resolve(recoveredFeed));
    expect(mocks.list).toHaveBeenCalledTimes(reads);
    expect(container.textContent).not.toContain("History response has arrived");
  });

  it("keeps the new workspace's response when an old workspace refresh was queued", async () => {
    const pendingOverview = await finishScanWhileFeedLoads();
    const pendingWorkspace = deferred<IssueFeed>();
    mocks.list.mockReturnValueOnce(pendingWorkspace.promise);
    await act(async () => {
      setActiveOrganizationId("org-2");
      window.dispatchEvent(new Event("focus"));
    });
    await act(async () => pendingOverview.resolve(emptyFeed));
    await act(async () => pendingWorkspace.resolve({
      ...recoveredFeed,
      status: "open",
      data: [{ ...recoveredFeed.data[0]!, message: "Current workspace incident", resolvedAt: undefined }],
    }));
    expect(container.textContent).toContain("Current workspace incident");
    expect(mocks.list).toHaveBeenCalledTimes(3);
    expect(mocks.toast).not.toHaveBeenCalled();
  });

  it("does not start a queued refresh in another workspace", async () => {
    const pendingOverview = await finishScanWhileFeedLoads();
    setActiveOrganizationId("org-2");
    await act(async () => pendingOverview.resolve(emptyFeed));
    expect(mocks.list).toHaveBeenCalledTimes(2);
    expect(mocks.toast).not.toHaveBeenCalled();
  });

  it("rechecks an unreachable row, disables repeat clicks and removes the recovered incident", async () => {
    vi.useFakeTimers();
    mocks.list.mockResolvedValue({ data: [{
      id: "incident:server", kind: "server_unreachable", severity: "action_required", scope: "server", source: "incident",
      title: "Remote server", message: "SSH handshake timed out", resolveWith: [],
      target: { scope: "server", id: "one", name: "Remote server", href: "/servers/one" },
    }], counts: { total: 1, outage: 0, actionRequired: 1, advisory: 0 } });
    mocks.rescan.mockResolvedValue({ data: running });
    await render();
    expect(container.textContent).toContain("Container health is unknown");
    await click("Recheck");
    expect(mocks.rescan).toHaveBeenCalledExactlyOnceWith({ healthOnly: true });
    expect(buttons("Scanning").every(button => button.disabled)).toBe(true);

    mocks.list.mockResolvedValue({ data: [], counts: { total: 0, outage: 0, actionRequired: 0, advisory: 0 } });
    mocks.rescanStatus.mockResolvedValue({ data: done });
    await act(async () => vi.advanceTimersByTimeAsync(1200));
    expect(container.textContent).not.toContain("SSH handshake timed out");
    expect(buttons("Scanning")).toHaveLength(0);
    expect(mocks.reload).toHaveBeenCalledOnce();
  });

  it("distinguishes a disconnected desktop and starts one health check after reconnecting", async () => {
    mocks.deployMode = "desktop";
    const online = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    mocks.rescan.mockResolvedValue({ data: running });
    await render();
    expect(container.textContent).toContain("This device is offline");
    expect(mocks.rescan).not.toHaveBeenCalled();
    online.mockReturnValue(true);
    await act(async () => window.dispatchEvent(new Event("online")));
    expect(container.textContent).not.toContain("This device is offline");
    expect(mocks.rescan).toHaveBeenCalledExactlyOnceWith({ healthOnly: true });
  });

  it("refreshes recovered incidents from the background watcher without running a scan", async () => {
    vi.useFakeTimers();
    await render();
    mocks.list.mockResolvedValue({ data: [], counts: { total: 0, outage: 0, actionRequired: 0, advisory: 0 } });
    await act(async () => vi.advanceTimersByTimeAsync(15_000));
    expect(container.textContent).not.toContain("Edge stopped");
    expect(mocks.rescan).not.toHaveBeenCalled();
  });

  it("does not claim nothing needs attention when the feed could not be read", async () => {
    mocks.list.mockRejectedValueOnce(new Error("Connection lost"));
    await render();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Couldn't load monitoring");
    expect(container.textContent).not.toContain("Nothing needs attention");
    mocks.list.mockResolvedValue({ data: [], counts: { total: 0, outage: 0, actionRequired: 0, advisory: 0 } });
    await click("Retry status");
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });
});

describe("Issues page operation logs (#660)", () => {
  it("reads background update logs inline through the existing GET stream", async () => {
    const live = stream();
    fetcher.mockResolvedValue(live.response);
    await render();
    await click("View logs");
    await act(async () => live.send({ type: "log", message: "Pulling the pinned image" }));
    expect(panel()?.textContent).toContain("Pulling the pinned image");
    expect(fetcher.mock.calls[0][0]).toBe(
      "http://localhost/api/system/servers/one/containers/edge/apply/stream",
    );
    expect(fetcher.mock.calls[0][1].method).toBe("GET");
    expect(mocks.showModal).not.toHaveBeenCalled();
  });

  it("ignores a late response after switching to another target", async () => {
    const pending = deferred<Response>();
    const old = stream();
    const current = stream();
    fetcher.mockReturnValueOnce(pending.promise).mockResolvedValueOnce(current.response);
    await render();
    await click("View logs", 0);
    mocks.serverIds = ["two"];
    await render();
    await click("View logs");
    await act(async () => {
      current.send({ type: "log", message: "Current target" });
      old.send({ type: "log", message: "Stale target" });
      old.send({ type: "complete", status: "completed" });
      pending.resolve(old.response);
    });
    expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true);
    expect(panel()?.textContent).toContain("Current target");
    expect(panel()?.textContent).not.toContain("Stale target");
    expect(old.cancel).toHaveBeenCalledOnce();
    expect(mocks.reload).not.toHaveBeenCalled();
  });

  it("dismisses only the reader while the fleet keeps reporting the update", async () => {
    const live = stream();
    fetcher.mockResolvedValue(live.response);
    await render();
    await click("View logs");
    await act(async () =>
      (container.querySelector('[aria-label="Close operation log"]') as HTMLButtonElement).click(),
    );
    expect(panel()).toBeNull();
    expect(live.cancel).toHaveBeenCalledOnce();
    expect(live.response.body?.locked).toBe(false);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(container.textContent).toContain("Updating 2 components");
  });

  it("reconnects a failed log without POSTing a new operation", async () => {
    const first = stream();
    const second = stream();
    fetcher.mockResolvedValueOnce(first.response).mockResolvedValueOnce(second.response);
    await render();
    await click("View logs");
    await act(async () => {
      first.send({ type: "complete", status: "failed" });
      first.close();
    });
    await click("Reconnect");
    expect(fetcher.mock.calls.map(([, opts]) => opts.method)).toEqual(["GET", "GET"]);
    expect(fetcher.mock.calls[1][0]).toBe(fetcher.mock.calls[0][0]);
  });

  it("restores a running install inline and preserves its consent response", async () => {
    mocks.install.mockResolvedValue({
      active: true,
      status: "running",
      sessionId: "install-1",
      serverId: "one",
    });
    const live = stream();
    fetcher.mockResolvedValueOnce(live.response).mockResolvedValueOnce(new Response("{}"));
    await render();
    await act(async () => {
      live.send({ type: "session", sessionId: "install-1" });
      live.send({
        type: "prompt",
        promptId: "ports",
        title: "Port takeover",
        message: "Continue?",
        actions: [{ id: "takeover", label: "Allow takeover" }],
      });
    });
    expect(panel()?.textContent).toContain("Port takeover");
    expect(fetcher.mock.calls[0][0]).toBe(
      "http://localhost/api/system/install/stream?id=install-1",
    );
    expect(fetcher.mock.calls[0][1].method).toBe("GET");
    await click("Allow takeover");
    expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({
      sessionId: "install-1",
      action: "takeover",
    });
    expect(mocks.showModal).not.toHaveBeenCalled();
  });

  it("runs a row's edge repair inline through the shared install flow", async () => {
    const live = stream();
    fetcher.mockResolvedValue(live.response);
    await render();
    await click("Fix");
    expect(panel()?.textContent).toContain("Install edge");
    expect(fetcher.mock.calls[0][0]).toBe("http://localhost/api/system/install/stream");
    expect(fetcher.mock.calls[0][1].method).toBe("POST");
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({
      serverId: "one",
      components: ["edge"],
    });
    expect(mocks.showModal).not.toHaveBeenCalled();
  });

  it("does not publish a late fallback outcome after its log was replaced", async () => {
    const pending = deferred<object[]>();
    mocks.containers.mockReturnValue(pending.promise);
    const old = stream();
    const current = stream();
    fetcher.mockResolvedValueOnce(old.response).mockResolvedValueOnce(current.response);
    await render();
    await click("View logs");
    await act(async () => old.close());
    await click("Fix");
    await act(async () => pending.resolve([{ component: "edge", behind: false }]));
    expect(panel()?.textContent).toContain("Installing the edge");
    expect(mocks.reload).not.toHaveBeenCalled();
  });

  it("does not replace the chosen log with a late install-recovery lookup", async () => {
    const pending = deferred<object>();
    mocks.install.mockReturnValue(pending.promise);
    const live = stream();
    fetcher.mockResolvedValue(live.response);
    await render();
    await click("View logs");
    await act(async () =>
      pending.resolve({ active: true, status: "running", sessionId: "install-1", serverId: "two" }),
    );
    expect(fetcher).toHaveBeenCalledOnce();
    expect(panel()?.textContent).toContain("Update Edge");
  });
});
