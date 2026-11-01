// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { baseDictionary } from "@/i18n";
import { LogsSettings } from "./LogsSettings";

const state = vi.hoisted(() => ({
  project: {
    name: "Example",
    deployTarget: "cloud",
    hasServer: false,
    workloadType: "static",
  } as Record<string, unknown>,
  clearTerminalLogs: vi.fn(),
  clearServerLogs: vi.fn(),
  searchParams: new URLSearchParams(),
  router: { replace: vi.fn() },
  terminalLogsData: { logs: ["runtime output"] },
  serverLogsData: {
    logs: [
      {
        timestamp: "today",
        ip: "127.0.0.1",
        method: "GET",
        path: "/",
        statusCode: 200,
        responseTime: 5,
      },
    ],
  },
  servicesData: { isLoading: false, services: [] },
  roles: {
    data: null as import("@repo/contracts").ProjectRuntimeRoles | null,
    loading: false,
    deploymentId: null as string | null,
    error: null as string | null,
    refresh: vi.fn(),
  },
}));

vi.mock("@/context/ProjectSettingsContext", () => ({
  useProjectSettings: () => ({
    projectData: state.project,
    buildData: { isLoading: false },
    id: "project",
    terminalLogsData: state.terminalLogsData,
    serverLogsData: state.serverLogsData,
    clearTerminalLogs: state.clearTerminalLogs,
    clearServerLogs: state.clearServerLogs,
    servicesData: state.servicesData,
  }),
}));
vi.mock("next/navigation", () => ({
  useSearchParams: () => state.searchParams,
  useRouter: () => state.router,
}));
vi.mock("@/hooks/useRuntimeRoles", () => ({ useRuntimeRoles: () => state.roles }));
vi.mock("@/components/i18n-provider", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  useI18n: () => ({ t: baseDictionary }),
}));
vi.mock("./logs/TerminalLogs", () => ({
  TerminalLogs: ({ streamTarget }: { streamTarget: string }) => (
    <output data-stream={streamTarget}>Terminal output</output>
  ),
}));
vi.mock("./logs/ServerLogs", () => ({
  ServerLogs: () => <output>HTTP Request Logs</output>,
}));

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.project = {
    name: "Example",
    deployTarget: "cloud",
    hasServer: false,
    workloadType: "static",
  };
  vi.clearAllMocks();
  state.searchParams = new URLSearchParams();
  state.roles.data = null;
  state.roles.deploymentId = null;
  state.roles.error = null;
  state.roles.loading = false;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const clearButton = () =>
  [...host.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent === baseDictionary.projectDetail.logs.actions.clear,
  )!;

describe("project log source controls", () => {
  function roleProject() {
    state.project = {
      name: "Example",
      framework: "laravel",
      deployTarget: "server",
      hasServer: true,
      activeDeploymentId: "dep_current",
    };
    state.roles.deploymentId = "dep_current";
    state.roles.data = {
      deploymentId: "dep_current",
      error: null,
      roles: [
        {
          name: "queue",
          kind: "worker",
          replicas: 2,
          containers: [{ replica: 2, containerId: "queue-2", status: "running", restartCount: 0 }],
        },
      ],
    };
  }

  it("opens a saved role replica in the terminal and preserves its release selector", async () => {
    roleProject();
    state.searchParams = new URLSearchParams({
      role: "queue",
      replica: "2",
      deploymentId: "dep_current",
    });
    await act(async () => root.render(<LogsSettings />));
    const output = host.querySelector("[data-stream]")!;
    const query = new URL(output.getAttribute("data-stream")!, "http://local").searchParams;
    expect(query.get("role")).toBe("queue");
    expect(query.get("replica")).toBe("2");
    expect(query.get("deploymentId")).toBe("dep_current");
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });

  it("does not replace a retired role selection with the live application's logs", async () => {
    roleProject();
    state.searchParams = new URLSearchParams({
      role: "queue",
      replica: "2",
      deploymentId: "dep_retired",
    });
    await act(async () => root.render(<LogsSettings />));
    expect(host.querySelector("[data-stream]")).toBeNull();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(
      baseDictionary.projectDetail.runtimeRoles.staleTarget,
    );
    expect(state.router.replace).not.toHaveBeenCalled();
    const picker = host.querySelector<HTMLButtonElement>('button[aria-haspopup="listbox"]')!;
    expect(picker).not.toBeNull();
    await act(async () => picker.click());
    const application = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
      (option) => option.textContent?.includes(baseDictionary.projectSettings.logs.projectRuntime),
    )!;
    await act(async () => application.click());
    expect(host.querySelector("[data-stream]")?.getAttribute("data-stream")).toBe(
      "projects/project/logs/stream",
    );
    expect(state.router.replace).toHaveBeenLastCalledWith("/projects/project/logs", {
      scroll: false,
    });
  });

  it("follows a changed role URL without rewriting it back to the previous selection", async () => {
    roleProject();
    state.roles.data!.roles.push({
      name: "scheduler",
      kind: "scheduler",
      replicas: 1,
      containers: [{ replica: 1, containerId: "scheduler-1", status: "running", restartCount: 0 }],
    });
    state.searchParams = new URLSearchParams({
      role: "queue",
      replica: "2",
      deploymentId: "dep_current",
    });
    await act(async () => root.render(<LogsSettings />));
    state.searchParams = new URLSearchParams({
      role: "scheduler",
      replica: "1",
      deploymentId: "dep_current",
    });
    await act(async () => root.render(<LogsSettings />));
    const query = new URL(
      host.querySelector("[data-stream]")!.getAttribute("data-stream")!,
      "http://local",
    ).searchParams;
    expect(query.get("role")).toBe("scheduler");
    expect(query.get("replica")).toBe("1");
    expect(state.router.replace).not.toHaveBeenCalled();
  });

  it("offers retry for a failed role lookup without streaming another container", async () => {
    roleProject();
    state.roles.data = null;
    state.roles.error = "Connection lost";
    state.searchParams = new URLSearchParams({
      role: "queue",
      replica: "2",
      deploymentId: "dep_current",
    });
    await act(async () => root.render(<LogsSettings />));
    expect(host.querySelector("[data-stream]")).toBeNull();
    const alert = host.querySelector('[role="alert"]')!;
    expect(alert.textContent).toContain("Connection lost");
    await act(async () =>
      [...alert.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent === baseDictionary.projectDetail.runtimeRoles.retry)!
        .click(),
    );
    expect(state.roles.refresh).toHaveBeenCalledOnce();
  });
  it("shows static request logs without a redundant tab or dangling panel label", async () => {
    await act(async () => root.render(<LogsSettings />));
    expect(host.querySelector('[role="tablist"]')).toBeNull();
    expect(host.querySelector('[role="tabpanel"]')).toBeNull();
    expect(host.querySelector("[aria-labelledby]")).toBeNull();
    const region = host.querySelector('[role="region"]');
    expect(region?.getAttribute("aria-label")).toBe(baseDictionary.projectSettings.logs.requests);
    expect(region?.textContent).toBe("HTTP Request Logs");
    await act(async () => clearButton().click());
    expect(state.clearServerLogs).toHaveBeenCalledOnce();
    expect(state.clearTerminalLogs).not.toHaveBeenCalled();
  });

  it("keeps keyboard selection, panel labels and actions tied to the active runtime source", async () => {
    state.project = { ...state.project, hasServer: true, workloadType: "web" };
    await act(async () => root.render(<LogsSettings />));
    const tabs = [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    expect(tabs.map((tab) => tab.textContent)).toEqual([
      baseDictionary.projectSettings.logs.terminal,
      baseDictionary.projectSettings.logs.server,
    ]);
    expect(tabs[0].getAttribute("aria-selected")).toBe("true");
    expect(tabs[0].tabIndex).toBe(0);
    expect(tabs[1].tabIndex).toBe(-1);
    expect(host.querySelector("output")?.getAttribute("data-stream")).toBe(
      "projects/project/logs/stream",
    );
    tabs[0].focus();
    await act(async () =>
      tabs[0].dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }),
      ),
    );
    expect(document.activeElement).toBe(tabs[1]);
    expect(tabs[1].getAttribute("aria-selected")).toBe("true");
    const panel = host.querySelector<HTMLElement>(
      `[id="${tabs[1].getAttribute("aria-controls")}"]`,
    )!;
    expect(panel.hidden).toBe(false);
    expect(panel.getAttribute("aria-labelledby")).toBe(tabs[1].id);
    expect(panel.textContent).toBe("HTTP Request Logs");
    await act(async () => clearButton().click());
    expect(state.clearServerLogs).toHaveBeenCalledOnce();
    expect(state.clearTerminalLogs).not.toHaveBeenCalled();

    await act(async () =>
      tabs[1].dispatchEvent(
        new KeyboardEvent("keydown", { key: "Home", bubbles: true, cancelable: true }),
      ),
    );
    expect(document.activeElement).toBe(tabs[0]);
    expect(tabs[0].getAttribute("aria-selected")).toBe("true");
    await act(async () => clearButton().click());
    expect(state.clearTerminalLogs).toHaveBeenCalledOnce();
  });
});
