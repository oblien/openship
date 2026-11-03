// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { HostPatchPlan, ServerSecurityResult } from "@repo/contracts";
import { baseDictionary } from "@/i18n";
import { ServerSecurityRuns } from "./ServerSecurityRuns";

const h = vi.hoisted(() => ({
  scope: "one",
  version: 1,
  get: vi.fn(),
  check: vi.fn(),
  plan: vi.fn(),
  apply: vi.fn(),
  runs: vi.fn(),
}));
vi.mock("@/hooks/useRunEvents", () => ({
  useRunEvents: () => ({ error: null, connected: true, reconnect: vi.fn() }),
}));
vi.mock("@/components/import-project/LogSnapshotTerminal", () => ({
  LogSnapshotTerminal: ({ logs }: { logs: string }) => <pre>{logs}</pre>,
}));
vi.mock("@/context/CloudResourceContext", () => ({ useCloudResourceKey: () => h.scope }));
vi.mock("@/lib/auth-client", () => ({
  useSession: () => ({
    data: { user: { id: "test-user" }, session: { activeOrganizationId: h.scope } },
  }),
}));
vi.mock("@/components/i18n-provider", () => ({ useI18n: () => ({ t: baseDictionary }) }));
vi.mock("@/lib/api/client", () => ({
  getApiRequestScopeVersion: () => h.version,
  getActiveOrganizationId: () => h.scope,
  subscribeActiveOrganization: () => () => {},
  getApiErrorMessage: (e: Error) => e.message,
}));
vi.mock("@/lib/api/server-security", () => ({ serverSecurityApi: h }));
const c = baseDictionary.projectSettings.hostSecurity;
let state: ServerSecurityResult;
let plan: HostPatchPlan;
let root: Root;
let container: HTMLDivElement;
function button(label: string) {
  const found = [...container.querySelectorAll("button")].find((b) => b.textContent === label);
  expect(found, label).toBeDefined();
  return found!;
}
const render = () => root.render(<ServerSecurityRuns serverId="customer-host" />);
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  h.scope = "one";
  h.version = 1;
  state = {
    serverId: "customer-host",
    name: "Customer host",
    checksEnabled: true,
    supported: true,
    canManage: true,
    checkedAt: new Date().toISOString(),
    nextCheckAt: null,
    error: null,
    feedStale: false,
    pending: false,
    findings: [
      {
        id: "HOST-TEST",
        revision: 1,
        title: "Host fixture notice",
        message: "Fixture",
        url: "https://ubuntu.com/security",
        severity: "high",
        packages: ["openssl"],
        evidence: ["openssl: 3.0.1"],
        state: "affected",
        canPatch: true,
        canReboot: false,
      },
    ],
  };
  plan = {
    operation: "install",
    token: "bound-reviewed-token",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    advisoryId: "HOST-TEST",
    title: "Host fixture notice",
    changes: [{ package: "openssl", previous: "3.0.1", version: "3.0.2" }],
    rebootRequired: false,
  };
  h.get.mockReset().mockImplementation(async () => ({ data: structuredClone(state) }));
  h.runs.mockReset().mockResolvedValue({ data: [] });
  h.check.mockReset().mockResolvedValue({ data: state });
  h.plan.mockReset().mockImplementation(async () => ({ data: plan }));
  h.apply.mockReset().mockResolvedValue({ data: { runId: "run-1" } });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("only reads on page load, reviews exact versions, and applies once into server history", async () => {
  await act(async () => render());
  expect(h.check).not.toHaveBeenCalled();
  expect(h.plan).not.toHaveBeenCalled();
  expect(h.apply).not.toHaveBeenCalled();
  await act(async () => button(c.reviewPatch).click());
  expect(h.plan).toHaveBeenCalledWith("customer-host", "HOST-TEST", "install");
  expect(container.textContent).toContain("3.0.2");
  expect(h.apply).not.toHaveBeenCalled();
  h.runs.mockResolvedValue({
    data: [
      {
        id: "run-1",
        startedAt: new Date().toISOString(),
        status: "running",
        summary: { advisoryId: "HOST-TEST" },
        output: "Installing reviewed packages",
      },
    ],
  });
  await act(async () => {
    button(c.applyPatch).click();
    button(c.applyPatch).click();
  });
  expect(h.apply).toHaveBeenCalledExactlyOnceWith("customer-host", "bound-reviewed-token");
  expect(container.textContent).toContain("Installing reviewed packages");
  expect(container.querySelector('a[href*="deployments"]')).toBeNull();
});
it("keeps rejected plans visible and does not invent a successful run", async () => {
  await act(async () => render());
  await act(async () => button(c.reviewPatch).click());
  h.apply.mockRejectedValueOnce(new Error("The server changed. Review a new plan."));
  await act(async () => button(c.applyPatch).click());
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("server changed");
  expect(container.textContent).toContain(c.noRuns);
});
it("refreshes the accepted run even while an older status request is pending", async () => {
  await act(async () => render());
  let resolve!: (value: { data: ServerSecurityResult }) => void;
  h.get.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  await act(async () => button(c.reviewPatch).click());
  h.runs.mockResolvedValue({
    data: [
      {
        id: "run-1",
        startedAt: new Date().toISOString(),
        status: "running",
        summary: { advisoryId: "HOST-TEST" },
        output: "Accepted run is visible immediately",
      },
    ],
  });
  await act(async () => button(c.applyPatch).click());
  expect(container.textContent).toContain("Accepted run is visible immediately");
  await act(async () => resolve({ data: state }));
  expect(container.textContent).toContain("Accepted run is visible immediately");
});
it("discards late reviewed plans after a workspace change", async () => {
  let resolve!: (value: { data: HostPatchPlan }) => void;
  h.plan.mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  await act(async () => render());
  await act(async () => button(c.reviewPatch).click());
  h.scope = "two";
  h.version++;
  state = { ...state, findings: [] };
  await act(async () => render());
  await act(async () => resolve({ data: plan }));
  expect(container.querySelector('[aria-label="' + c.patchDetails + '"]')).toBeNull();
  expect(h.apply).not.toHaveBeenCalled();
});
it("requires a separate reboot review and displays workload interruption before submission", async () => {
  state.findings[0] = {
    ...state.findings[0]!,
    state: "reboot_required",
    canPatch: false,
    canReboot: true,
  };
  plan = { ...plan, operation: "reboot", changes: [], rebootRequired: true };
  await act(async () => render());
  await act(async () => button(c.reviewReboot).click());
  expect(h.plan).toHaveBeenCalledWith("customer-host", "HOST-TEST", "reboot");
  expect(container.textContent).toContain(c.rebootInterruption);
  expect(h.apply).not.toHaveBeenCalled();
  await act(async () => button(c.applyReboot).click());
  expect(h.apply).toHaveBeenCalledTimes(1);
});
it("keeps disabled checks visible without permitting a probe or patch", async () => {
  state = { ...state, checksEnabled: false, findings: [] };
  await act(async () => render());
  expect(button(baseDictionary.projectSettings.securityAdvisories.checkAgain).disabled).toBe(true);
  expect(container.textContent).toContain(
    baseDictionary.projectSettings.securityAdvisories.checksDisabled,
  );
  expect(h.check).not.toHaveBeenCalled();
  expect(h.apply).not.toHaveBeenCalled();
});

it("keeps saved runs available when host execution becomes unsupported", async () => {
  state = { ...state, supported: false, findings: [] };
  h.runs.mockResolvedValue({
    data: [
      {
        id: "saved-run",
        startedAt: new Date().toISOString(),
        status: "failed",
        summary: { advisoryId: "HOST-TEST", phase: "needs_review" },
        output: "Saved diagnostic output",
      },
    ],
  });
  await act(async () => render());
  expect(h.runs).toHaveBeenCalledWith("customer-host");
  const history = container.querySelector<HTMLButtonElement>('button[aria-expanded="false"]');
  expect(history).not.toBeNull();
  await act(async () => history!.click());
  expect(container.textContent).toContain("Saved diagnostic output");
  expect(button(baseDictionary.projectSettings.securityAdvisories.checkAgain).disabled).toBe(true);
  expect(h.check).not.toHaveBeenCalled();
  expect(h.plan).not.toHaveBeenCalled();
  expect(h.apply).not.toHaveBeenCalled();
});
