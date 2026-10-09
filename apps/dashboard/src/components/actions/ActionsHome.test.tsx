// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/components/i18n-provider";
import { ActionsHome } from "./ActionsHome";

const h = vi.hoisted(() => ({
  list: vi.fn(),
  runs: vi.fn(),
  runners: vi.fn(),
  probe: vi.fn(),
  selfHosted: true,
}));
vi.mock("@/lib/api/actions", () => ({
  actionsApi: { list: h.list, runs: h.runs, runners: h.runners, probeRunner: h.probe },
}));
vi.mock("@/lib/auth-client", () => ({
  useSession: () => ({ data: { user: { id: "owner" }, session: { activeOrganizationId: "org" } } }),
}));
vi.mock("@/context/CloudResourceContext", () => ({ useCloudResourceKey: () => "local" }));
vi.mock("@/context/PlatformContext", () => ({
  usePlatform: () => ({ selfHosted: h.selfHosted, deployMode: h.selfHosted ? "desktop" : "cloud" }),
}));

const runner = {
  id: "runner",
  name: "Linux CI",
  kind: "server",
  enabled: true,
  error: null,
  labels: ["linux"],
};
const workflow = {
  id: "ci",
  name: "CI",
  owner: "example",
  repo: "app",
  path: ".github/workflows/ci.yml",
  enabled: true,
  lastError: null,
};
let root: Root;
let host: HTMLDivElement;
const render = () =>
  act(async () =>
    root.render(
      <I18nProvider>
        <ActionsHome />
      </I18nProvider>,
    ),
  );
const click = (name: string) =>
  act(async () => {
    const button = [...host.querySelectorAll("button")].find(
      (button) => button.textContent === name,
    );
    expect(button, `Missing button: ${name}`).toBeTruthy();
    button!.click();
  });

beforeEach(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  vi.resetAllMocks();
  h.selfHosted = true;
  h.list.mockResolvedValue([]);
  h.runs.mockResolvedValue([]);
  h.runners.mockResolvedValue([]);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe("Actions home setup flow", () => {
  it("starts with runner setup on an empty connected instance", async () => {
    await render();
    const action = host.querySelector('[role="tabpanel"] a');
    expect(action?.textContent).toBe("Add runner");
    expect(action?.getAttribute("href")).toBe("/actions/runners/new");
    expect(host.querySelector('[aria-current="step"]')?.textContent).toContain("Choose a runner");
  });

  it("takes first-time Cloud users to the separate Actions budget", async () => {
    h.selfHosted = false;
    await render();
    const action = host.querySelector('[role="tabpanel"] a');
    expect(action?.textContent).toBe("Set up Cloud runners");
    expect(action?.getAttribute("href")).toBe("/actions/billing");
    expect(host.textContent).not.toContain("Keep automations online");
  });

  it("offers workflow creation once a runner is ready", async () => {
    h.runners.mockResolvedValue([runner]);
    await render();
    expect(host.querySelector('[role="tabpanel"] a')?.getAttribute("href")).toBe("/actions/new");
    expect(host.querySelector('[aria-current="step"]')?.textContent).toContain(
      "Connect a workflow",
    );
  });

  it("opens existing runners for review when none can run jobs", async () => {
    h.runners.mockResolvedValue([{ ...runner, enabled: false }]);
    await render();
    await click("Review runners");
    expect(host.querySelector('[role="tabpanel"]')?.id).toBe("actions-panel-runners");
    expect(host.querySelector('[role="tabpanel"]')?.textContent).toContain("Linux CI");
    expect(h.probe).not.toHaveBeenCalled();
  });

  it("opens the saved workflow from empty run history without dispatching it", async () => {
    h.runners.mockResolvedValue([runner]);
    h.list.mockResolvedValue([workflow]);
    await render();
    await click("Runs");
    const action = host.querySelector('[role="tabpanel"] a');
    expect(action?.textContent).toBe("Open workflow");
    expect(action?.getAttribute("href")).toBe("/actions/workflows/ci");
  });

  it("keeps a failed fetch distinct from a new account and retries it", async () => {
    h.list.mockRejectedValueOnce(new Error("Workflow service unavailable"));
    await render();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(
      "Workflow service unavailable",
    );
    expect(host.textContent).not.toContain("From commit to done");
    expect(host.textContent).not.toContain("Get started");
    await click("Try again");
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(host.textContent).toContain("From commit to done");
  });

  it("shows the latest run instead of setup guidance for an established account", async () => {
    h.runners.mockResolvedValue([runner]);
    h.list.mockResolvedValue([workflow]);
    h.runs.mockResolvedValue([
      { id: "run-1", workflowId: "ci", name: "CI", number: 1, status: "success" },
    ]);
    await render();
    const sidebar = host.querySelector("aside")!;
    expect(sidebar.textContent).toContain("At a glance");
    expect(sidebar.textContent).not.toContain("Get started");
    expect(sidebar.querySelector('a[href="/actions/runs/run-1"]')?.textContent).toContain(
      "Succeeded",
    );
  });
});
