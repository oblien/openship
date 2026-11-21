// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkloadScaling } from "@repo/contracts";
import { TopologyWorkloadScaling } from "./TopologyWorkloadScaling";
import type { TopologyProject } from "./model";
import type { Service } from "@/lib/api/services";
const h = vi.hoisted(() => ({ get: vi.fn(), scale: vi.fn(), push: vi.fn(), scope: "org:one" }));
vi.mock("@/lib/api/workload-scaling", () => ({
  workloadScalingApi: { get: h.get, scale: h.scale },
}));
vi.mock("@/hooks/use-scoped-resource", () => ({ useResourceScope: () => h.scope }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: h.push }) }));
const state = (): WorkloadScaling => ({
  replicas: 3,
  activeReplicas: 1,
  activeDeploymentId: "active",
  updatedAt: "revision",
  serviceId: null,
  unavailableReason: null,
  error: null,
  status: {
    desired: 1,
    ready: 1,
    available: 1,
    updated: 1,
    generation: 1,
    observedGeneration: 1,
    pods: [{ name: "Instance 1", nodeName: null, ready: true, phase: "running", restarts: 0 }],
    message: null,
  },
});
let host: HTMLDivElement, root: Root;
const project = {
  id: "project",
  name: "Shop",
  serverName: "Production",
  activeDeploymentId: "active",
} as TopologyProject;
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  h.scope = "org:one";
  h.get.mockResolvedValue(state());
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
async function render(service?: Service, disabled = false) {
  await act(async () =>
    root.render(
      <TopologyWorkloadScaling project={project} service={service} disabled={disabled} />,
    ),
  );
}
const button = (text: string) =>
  [...document.querySelectorAll("button")].find((item) => item.textContent?.trim() === text)!;
describe("single-server instance controls", () => {
  it("uses the shared review, warns about replacement and submits only once", async () => {
    let resolve!: (value: { deploymentId: string }) => void;
    h.scale.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    await render({ id: "api", name: "API" } as Service);
    expect(h.get).toHaveBeenCalledWith("project", "api");
    expect(host.textContent).toContain("1 / 1");
    await act(async () => button("Review scaling").click());
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("1 → 3 instances");
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("briefly unavailable");
    await act(async () => {
      button("Apply scaling").click();
      button("Apply scaling").click();
    });
    expect(h.scale).toHaveBeenCalledOnce();
    expect(h.scale).toHaveBeenCalledWith("project", {
      serviceId: "api",
      replicas: 3,
      expectedDeploymentId: "active",
      expectedUpdatedAt: "revision",
    });
    await act(async () => resolve({ deploymentId: "new-release" }));
    expect(h.push).toHaveBeenCalledWith("/build/new-release");
    expect(button("Apply scaling").disabled).toBe(true);
  });
  it("honors action locks and runtime capability failures", async () => {
    await render(undefined, true);
    expect(button("Review scaling").disabled).toBe(true);
    h.get.mockResolvedValue({
      ...state(),
      unavailableReason: "This target does not support replicas.",
    });
    h.scope = "org:two";
    await render();
    expect(host.textContent).toContain("does not support replicas");
    expect(host.querySelector('input[type="number"]')).toBeNull();
    expect(h.scale).not.toHaveBeenCalled();
  });
  it("clears private state and review when switching account scope", async () => {
    await render();
    await act(async () => button("Review scaling").click());
    h.get.mockImplementation(() => new Promise(() => {}));
    h.scope = "org:two";
    await render();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(host.textContent).not.toContain("Instance 1");
  });
  it("does not blindly repeat a failed submission", async () => {
    h.scale.mockRejectedValue(new Error("The release changed. Refresh."));
    await render();
    await act(async () => button("Review scaling").click());
    await act(async () => button("Apply scaling").click());
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("release changed");
    expect(button("Review scaling").disabled).toBe(true);
    expect(h.scale).toHaveBeenCalledOnce();
    await act(async () => button("Refresh").click());
    expect(button("Review scaling").disabled).toBe(false);
  });
});
