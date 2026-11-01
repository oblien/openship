// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SYSTEM } from "@repo/core";
import { baseDictionary } from "@/i18n";
import {
  DEFAULT_CONFIG,
  INITIAL_STATE,
  type DeploymentContextType,
} from "@/context/deployment/types";
import { CloudDeploymentResourceNotice } from "./CloudDeploymentResourceNotice";

let deployment: Pick<DeploymentContextType, "config" | "state" | "deploymentStatus">;
const h = vi.hoisted(() => ({
  show: vi.fn(),
  hide: vi.fn(),
  destinations: vi.fn(),
  billing: vi.fn(),
}));
vi.mock("@/context/DeploymentContext", () => ({ useDeployment: () => deployment }));
vi.mock("@/context/ModalContext", () => ({
  useModal: () => ({ showModal: h.show, hideModal: h.hide }),
}));
vi.mock("@/components/i18n-provider", () => ({ useI18n: () => ({ t: baseDictionary }) }));
vi.mock("@/hooks/useServerDestinations", () => ({ useServerDestinations: h.destinations }));
vi.mock("@/components/billing/CloudDeployPlanModal", () => ({
  CloudDeployPlanModal: (props: unknown) => {
    h.billing(props);
    return <div>Plan comparison</div>;
  },
}));
let root: Root;
let dialogRoot: Root | null;
let host: HTMLDivElement;
let dialogHost: HTMLDivElement;
const copy = baseDictionary.deployments.resourceGuidance;
const start = new Date("2026-10-19T12:00:00Z");

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(start);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  h.show.mockReturnValue("modal");
  h.destinations.mockReturnValue({ loading: false, data: { servers: [] } });
  deployment = {
    config: {
      ...structuredClone(DEFAULT_CONFIG),
      projectId: "project",
      deployTarget: "cloud",
      workspaceId: "space-current",
    },
    state: {
      ...structuredClone(INITIAL_STATE),
      deploymentId: "attempt",
      projectId: "project",
      deploymentFailed: true,
      errorDetails: { resourceIssue: "memory-allocation", workspaceId: "space-original" },
    },
    deploymentStatus: "failed",
  };
  host = document.createElement("div");
  dialogHost = document.createElement("div");
  document.body.append(host, dialogHost);
  root = createRoot(host);
  dialogRoot = null;
});
afterEach(async () => {
  await act(async () => {
    root.unmount();
    dialogRoot?.unmount();
  });
  host.remove();
  dialogHost.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
async function render() {
  await act(async () => root.render(<CloudDeploymentResourceNotice />));
}
function review() {
  return [...host.querySelectorAll("button")].find(
    (button) => button.textContent === copy.reviewCapacity,
  );
}

it("restores the saved cause and opens the existing plan flow only on click, on the original space", async () => {
  await render();
  expect(host.textContent).toContain(copy.titles["memory-allocation"]);
  expect(h.show).not.toHaveBeenCalled();
  expect(h.destinations).not.toHaveBeenCalled();
  await act(async () => {
    review()!.click();
    review()!.click();
  });
  expect(h.show).toHaveBeenCalledTimes(1);
  dialogRoot = createRoot(dialogHost);
  await act(async () => dialogRoot!.render(h.show.mock.calls[0]![0].customContent));
  const upgrade = [...dialogHost.querySelectorAll("button")].find(
    (button) => button.textContent === baseDictionary.billing.pricing.upgrade,
  )!;
  await act(async () => upgrade.click());
  expect(h.billing).toHaveBeenLastCalledWith(
    expect.objectContaining({ workspaceId: "space-original", onRetry: undefined }),
  );
  expect(host.textContent).toContain(copy.titles["memory-allocation"]);
});

it.each(["process-heap", "process-killed"] as const)(
  "explains %s without offering a plan as a proven fix",
  async (resourceIssue) => {
    deployment.state.errorDetails = { resourceIssue, workspaceId: "space-original" };
    await render();
    expect(host.textContent).toContain(copy.causes[resourceIssue]);
    expect(review()).toBeUndefined();
    expect(host.querySelector("a")?.getAttribute("href")).toContain("mode=config");
  },
);

it("does not guess a historical deployment's space from the current project configuration", async () => {
  deployment.state.errorDetails = { resourceIssue: "storage-full" };
  await render();
  expect(host.textContent).toContain(copy.titles["storage-full"]);
  expect(review()).toBeUndefined();
});

it("keeps existing build-capacity refusals actionable after reopening", async () => {
  deployment.state.errorCode = "CLOUD_WORKSPACE_BUILD_CAPACITY";
  deployment.state.errorDetails = { workspaceId: "space-original" };
  await render();
  expect(host.textContent).toContain(baseDictionary.billing.workspaces.buildCapacityTitle);
  expect(review()).toBeDefined();
  expect(h.show).not.toHaveBeenCalled();
});

it("keeps a partial attempt's diagnosis after acknowledgement, and clears it for a new success or self-hosted target", async () => {
  deployment.state.deploymentFailed = false;
  deployment.state.decisionPending = true;
  deployment.deploymentStatus = "ready";
  await render();
  expect(review()).toBeDefined();
  deployment.state.decisionPending = false;
  await render();
  expect(review()).toBeDefined();
  deployment.state.errorDetails = null;
  await render();
  expect(host.textContent).toBe("");
  deployment.state.deploymentFailed = true;
  deployment.config.deployTarget = "server";
  await render();
  expect(host.textContent).toBe("");
});

it("shows slow-build advice using the local clock, and stops it after completion", async () => {
  deployment.state = {
    ...structuredClone(INITIAL_STATE),
    deploymentId: "attempt",
    projectId: "project",
    isDeploying: true,
    currentStepIndex: 3,
    buildStartedAt: start.toISOString(),
  };
  deployment.deploymentStatus = "building";
  await render();
  expect(host.textContent).toBe("");
  await act(async () => vi.advanceTimersByTime(SYSTEM.DEPLOYMENTS.SLOW_BUILD_NOTICE_MS));
  expect(host.textContent).toContain(copy.slowTitle);
  expect(h.destinations).not.toHaveBeenCalled();
  expect(h.billing).not.toHaveBeenCalled();
  expect(h.show).not.toHaveBeenCalled();
  deployment.state.deploymentSuccess = true;
  deployment.state.isDeploying = false;
  deployment.deploymentStatus = "ready";
  await render();
  expect(host.textContent).toBe("");
});

it("suppresses elapsed-time advice during queueing, preparation, prompts and cancellation", async () => {
  deployment.state = {
    ...structuredClone(INITIAL_STATE),
    deploymentId: "attempt",
    isDeploying: true,
    currentStepIndex: 3,
    buildStartedAt: start.toISOString(),
  };
  deployment.deploymentStatus = "building";
  vi.setSystemTime(start.getTime() + SYSTEM.DEPLOYMENTS.SLOW_BUILD_NOTICE_MS);
  for (const patch of [
    { currentStepIndex: 0 },
    { currentStepIndex: 1 },
    { queue: { position: 1 } as typeof deployment.state.queue },
    { pendingPrompt: { promptId: "prompt" } as typeof deployment.state.pendingPrompt },
    { cancellationPending: true },
  ]) {
    const previous = deployment.state;
    deployment.state = { ...previous, ...patch };
    await render();
    expect(host.textContent).toBe("");
    deployment.state = previous;
  }
});

it("closes the old capacity dialog when the attempt changes", async () => {
  await render();
  await act(async () => review()!.click());
  deployment.state.deploymentId = "another-attempt";
  await render();
  expect(h.hide).toHaveBeenCalledWith("modal");
});
