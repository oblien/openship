// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TopologyInspector } from "./TopologyInspector";
import type { TopologyResource } from "./model";

vi.mock("@/context/ToastContext", () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock("./TopologyScaling", () => ({
  TopologyScaling: () => <div>Replica scaling controls</div>,
}));
vi.mock("./TopologyCanvas", () => ({
  TopologyResourceIcon: () => null,
  TopologyStatus: () => <span>Running</span>,
}));
vi.mock("@/components/services/RuntimeRoles", () => ({ RuntimeRoleReplicas: () => null }));
vi.mock("@/app/(dashboard)/projects/[id]/components/services/ServiceSettingsForm", () => ({
  ServiceSettingsForm: () => null,
}));

let host: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
async function render(busy = false, patch: Partial<TopologyResource> = {}) {
  const resource: TopologyResource = {
    id: "app",
    kind: "application",
    projectId: "project",
    name: "API",
    description: "Application",
    tone: "service",
    state: "running",
    ...patch,
  };
  await act(async () =>
    root.render(
      <TopologyInspector
        project={{ id: "project", name: "API", framework: "express" }}
        graph={{ nodes: [resource], edges: [] }}
        resource={resource}
        disabled={false}
        busy={busy}
        hasPendingChanges={false}
        onClose={vi.fn()}
        onNavigate={vi.fn()}
        onSave={vi.fn()}
        onResources={vi.fn()}
        onPlacement={vi.fn()}
        onLifecycle={vi.fn()}
        onDeploy={vi.fn()}
        onRemoveRelation={vi.fn()}
        onSelectRelation={vi.fn()}
      />,
    ),
  );
}

describe("topology quick scaling", () => {
  it("opens the existing Scale tab from the selected application overview", async () => {
    await render();
    const quick = [...host.querySelectorAll<HTMLButtonElement>('button:not([role="tab"])')].find(
      (node) => node.textContent?.trim() === "Scale",
    )!;
    await act(async () => quick.click());
    expect(host.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe("Scale");
    expect(host.textContent).toContain("Replica scaling controls");
  });
  it("holds the quick action while a lifecycle operation is running", async () => {
    await render(true);
    const quick = [...host.querySelectorAll<HTMLButtonElement>('button:not([role="tab"])')].find(
      (node) => node.textContent?.trim() === "Scale",
    )!;
    expect(quick.disabled).toBe(true);
  });
  it("keeps observed individual pods as inspection instead of independent scale targets", async () => {
    await render(false, {
      kind: "instance",
      clusterPod: {
        name: "api-1",
        nodeName: "server",
        serverId: null,
        serverName: "Production",
        phase: "Running",
        ready: true,
        restarts: 0,
      },
    });
    expect(host.querySelector('[role="tablist"]')).toBeNull();
    expect(host.textContent).not.toContain("Replica scaling controls");
  });
});
