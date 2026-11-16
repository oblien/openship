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
  it("uses one Scale entry in the tab bar", async () => {
    await render();
    const quick = [...host.querySelectorAll<HTMLButtonElement>('button[role="tab"]')].find(
      (node) => node.textContent?.trim() === "Scale",
    )!;
    expect([...host.querySelectorAll('button:not([role="tab"])')].some(node => node.textContent?.trim() === "Scale")).toBe(false);
    await act(async () => quick.click());
    expect(host.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe("Scale");
    expect(host.textContent).toContain("Replica scaling controls");
  });
  it("keeps actions above runtime details and shows status once", async () => {
    await render(true);
    const deploy = [...host.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.includes("Deploy latest source"))!;
    expect(deploy.disabled).toBe(true);
    expect(host.textContent?.match(/Running/g)).toHaveLength(1);
    const details = host.querySelector('details')!;
    expect(details.open).toBe(false);
    expect(details.textContent).toContain("Runtime details");
    expect(deploy.compareDocumentPosition(details) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
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
