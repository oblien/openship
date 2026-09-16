// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/components/i18n-provider";
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
}));
vi.mock("@/context/ModalContext", () => ({
  useModal: () => ({ showModal: mocks.showModal, hideModal: mocks.hideModal }),
}));
vi.mock("@/context/PlatformContext", () => ({ usePlatform: () => ({ selfHosted: true }) }));
vi.mock("@/components/toast", () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock("@/components/issues/MonitoringHealth", () => ({ MonitoringHealth: () => null }));
vi.mock("@/lib/api", () => ({
  getApiBaseUrl: () => "http://localhost/api/",
  getApiErrorMessage: (_: unknown, fallback: string) => fallback,
  issuesApi: { list: mocks.list, rescanStatus: async () => ({ data: null }) },
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
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
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
