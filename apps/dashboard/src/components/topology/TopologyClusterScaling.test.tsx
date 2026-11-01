// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectCluster } from "@repo/contracts";
import type { TopologyProject } from "./model";
import { TopologyClusterScaling } from "./TopologyClusterScaling";

const h = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
  scale: vi.fn(),
  list: vi.fn(),
  push: vi.fn(),
  update: vi.fn(),
  deploy: vi.fn(),
  selfHosted: true,
  scope: "user:org:instance",
}));
vi.mock("@/hooks/use-scoped-resource", () => ({ useResourceScope: () => h.scope }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: h.push }) }));
vi.mock("@/context/PlatformContext", () => ({ usePlatform: () => ({ selfHosted: h.selfHosted }) }));
vi.mock("@/context/ProjectSettingsContext", () => ({
  useProjectSettings: () => ({ updateProjectData: h.update }),
}));
vi.mock("@/lib/api/project-cluster", () => ({
  projectClusterApi: { get: h.get, set: h.set, scale: h.scale },
}));
vi.mock("@/lib/api/compute-clusters", () => ({ computeClustersApi: { list: h.list } }));

const state = (): ProjectCluster => ({
  clusterId: "cluster",
  config: { replicas: 3, imageRepository: "ghcr.io/team/api" },
  serverId: null,
  requiresImageRepository: true,
  updatedAt: "2026-09-21T09:00:00Z",
  activeDeploymentId: "release",
  activeClusterId: "cluster",
  internalHost: "app.project.svc.cluster.local",
  error: null,
  status: {
    desired: 2,
    ready: 2,
    available: 2,
    updated: 2,
    generation: 1,
    observedGeneration: 1,
    message: null,
    pods: [
      {
        name: "api-pod",
        nodeName: "server-a",
        serverId: "a",
        serverName: "Production API",
        ready: true,
        phase: "Running",
        restarts: 0,
      },
    ],
  },
});
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  h.selfHosted = true;
  h.scope = "user:org:instance";
  h.get.mockResolvedValue(state());
  h.list.mockResolvedValue([
    {
      id: "cluster",
      name: "Production",
      serverIds: ["a", "b"],
      scaling: { status: "ready", verifiedAt: null },
    },
  ]);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
async function render(target = "cluster", framework = "express") {
  const project = {
    id: "project",
    framework,
    deployTarget: target,
    activeDeploymentId: "release",
  } as TopologyProject;
  await act(async () =>
    root.render(<TopologyClusterScaling project={project} disabled={false} onDeploy={h.deploy} />),
  );
}
const button = (text: string) =>
  [...host.querySelectorAll("button")].find((element) => element.textContent?.trim() === text)!;
async function selectCluster(id: string) {
  await act(async () =>
    host.querySelector<HTMLButtonElement>('[aria-label="Project cluster"]')!.click(),
  );
  const options = [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')];
  await act(async () => options.find((option) => option.textContent?.includes(id))!.click());
}

describe("topology cluster scaling", () => {
  it("does not offer scaling just because a Compose stack has multiple services", async () => {
    h.get.mockResolvedValue({ ...state(), activeReplicas: 3, status: { ...state().status, desired: 7, ready: 7 } });
    await render();
    expect(host.textContent).toContain("7 / 7");
    expect(button("Apply scaling")).toBeUndefined();
  });
  it("shows observed replicas and holds the action lock until deployment navigation", async () => {
    let resolve!: (value: { deploymentId: string }) => void;
    h.scale.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    await render();
    expect(host.textContent).toContain("2 / 2");
    expect(host.querySelector("li")?.textContent).toContain("Instance 1 · Production API");
    expect(host.querySelector("li")?.textContent).not.toContain("api-pod");
    const technical = [...host.querySelectorAll("details")].find(
      (element) => element.querySelector("summary")?.textContent === "Technical details",
    )!;
    expect(technical.open).toBe(false);
    expect(technical.textContent).toContain("api-pod");
    const open = button("Review scaling");
    await act(async () => open.click());
    expect(h.scale).not.toHaveBeenCalled();
    const apply = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(element => element.textContent?.trim() === "Apply scaling")!;
    await act(async () => {
      apply.click();
      apply.click();
    });
    expect(h.scale).toHaveBeenCalledOnce();
    expect(h.scale).toHaveBeenCalledWith("project", {
      replicas: 3,
      expectedDeploymentId: "release",
      expectedUpdatedAt: state().updatedAt,
    });
    expect(apply.disabled).toBe(true);
    await act(async () => resolve({ deploymentId: "next-release" }));
    expect(h.push).toHaveBeenCalledWith("/build/next-release");
    expect(apply.disabled).toBe(true);
  });
  it("cancels review without changing the desired count or starting a release", async () => {
    await render();
    await act(async () => button("Review scaling").click());
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("2 → 3 instances");
    await act(async () => [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(element => element.textContent?.trim() === "Back")!.click());
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(h.scale).not.toHaveBeenCalled();
    expect(h.set).not.toHaveBeenCalled();
    expect(h.push).not.toHaveBeenCalled();
  });
  it("clears review and private cluster state when the account scope changes", async () => {
    await render();
    await act(async () => button("Review scaling").click());
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    h.scope = "other:org:instance";
    h.get.mockResolvedValue({ ...state(), config: { replicas: 2 }, status: null });
    await render();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(h.scale).not.toHaveBeenCalled();
  });
  it("shows the backend's unsupported reason without editable scaling controls", async () => {
    h.get.mockResolvedValue({ ...state(), unavailableReason: "This environment contains services." });
    await render();
    expect(host.textContent).toContain("This environment contains services.");
    expect(host.querySelector('[aria-label="Project cluster"]')).toBeNull();
    expect(button("Review scaling")).toBeUndefined();
    expect(h.set).not.toHaveBeenCalled();
  });
  it("reconciles a failed response once and leaves retry to the user", async () => {
    h.scale.mockRejectedValue(new Error("Registry could not be reached"));
    await render();
    await act(async () => button("Review scaling").click());
    await act(async () => [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(element => element.textContent?.trim() === "Apply scaling")!.click());
    expect(host.textContent).toContain("Registry could not be reached");
    expect(h.get).toHaveBeenCalledTimes(2);
    expect(h.scale).toHaveBeenCalledOnce();
    expect(button("Review scaling").disabled).toBe(false);
    expect(h.push).not.toHaveBeenCalled();
  });
  it("keeps observed application scaling available when the fleet catalog cannot be read", async () => {
    h.list.mockRejectedValue(new Error("Servers unavailable"));
    await render();
    expect(host.textContent).toContain("Servers unavailable");
    expect(host.querySelector('a[href="/servers/clusters/new"]')).toBeNull();
    expect(button("Review scaling").disabled).toBe(false);
    expect(host.querySelector('[aria-label="Project cluster"]')?.hasAttribute("disabled")).toBe(
      true,
    );
  });
  it("keeps self-hosted scaling out of Cloud projects", async () => {
    await render("cloud");
    expect(h.get).not.toHaveBeenCalled();
    expect(host.textContent).toBe("");
  });
  it.each([
    null,
    { status: "setting_up", verifiedAt: null },
    { status: "interrupted", verifiedAt: null },
    undefined,
  ])("requires scaling readiness independently of network membership (%j)", async (scaling) => {
    if (scaling === undefined) h.get.mockResolvedValue({ ...state(), status: null });
    h.list.mockResolvedValue([
      { id: "cluster", name: "Production", serverIds: ["a", "b"], scaling },
    ]);
    await render();
    expect(button("Prepare scaling")).toBeDefined();
    expect(host.querySelector('input[type="number"]')).toBeNull();
    const apply = button(scaling === undefined ? "Review deployment" : "Review scaling");
    expect(apply.disabled).toBe(true);
    await act(async () => apply.click());
    expect(h.scale).not.toHaveBeenCalled();
    expect(h.set).not.toHaveBeenCalled();
  });
  it("saves a ready target once and opens the existing deployment review for a prebuilt application", async () => {
    const initial = {
      ...state(),
      clusterId: null,
      config: null,
      serverId: "a",
      activeClusterId: null,
      status: null,
      requiresImageRepository: false,
    };
    h.get.mockResolvedValue(initial);
    const saved = {
      ...initial,
      clusterId: "cluster",
      serverId: null,
      config: { replicas: 1 },
      updatedAt: "2026-09-21T10:00:00Z",
    };
    h.set.mockResolvedValue(saved);
    await render("server");
    await selectCluster("Production");
    expect(host.textContent).not.toContain("Image repository");
    expect(button("Review deployment").disabled).toBe(true);
    await act(async () => host.querySelector<HTMLButtonElement>('[role="checkbox"]')!.click());
    const review = button("Review deployment");
    await act(async () => {
      review.click();
      review.click();
    });
    expect(h.set).toHaveBeenCalledOnce();
    expect(h.set).toHaveBeenCalledWith("project", {
      clusterId: "cluster",
      config: { replicas: 1 },
      expectedUpdatedAt: initial.updatedAt,
      stateless: true,
    });
    expect(h.update).toHaveBeenCalledWith(
      expect.objectContaining({ deployTarget: "cluster", clusterId: "cluster", serverId: null }),
    );
    expect(h.deploy).toHaveBeenCalledOnce();
    expect(h.scale).not.toHaveBeenCalled();
  });
  it("recovers a saved target after a lost response without starting a deployment", async () => {
    const initial = {
      ...state(),
      clusterId: null,
      config: null,
      serverId: "a",
      activeClusterId: null,
      status: null,
      requiresImageRepository: false,
    };
    const saved = {
      ...initial,
      clusterId: "cluster",
      serverId: null,
      config: { replicas: 1 },
      updatedAt: "2026-09-21T10:00:00Z",
    };
    h.get.mockResolvedValueOnce(initial).mockResolvedValue(saved);
    h.set.mockRejectedValue(new Error("Connection lost"));
    await render("server");
    await selectCluster("Production");
    await act(async () => host.querySelector<HTMLButtonElement>('[role="checkbox"]')!.click());
    await act(async () => button("Review deployment").click());
    expect(h.get).toHaveBeenCalledTimes(2);
    expect(h.set).toHaveBeenCalledOnce();
    expect(h.deploy).not.toHaveBeenCalled();
    expect(h.update).toHaveBeenCalledWith(
      expect.objectContaining({ deployTarget: "cluster", clusterId: "cluster" }),
    );
    expect(host.textContent).toContain("Connection lost");
    await act(async () => button("Review deployment").click());
    expect(h.set).toHaveBeenCalledOnce();
    expect(h.deploy).toHaveBeenCalledOnce();
  });
  it("blocks stale controls if refreshing the project state fails", async () => {
    await render();
    h.get.mockRejectedValue(new Error("Application status unavailable"));
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[aria-label="Refresh scaling status"]')!.click(),
    );
    expect(host.textContent).toContain("Application status unavailable");
    expect(button("Review scaling")).toBeUndefined();
    expect(h.scale).not.toHaveBeenCalled();
  });
  it("requires image delivery for a source build before deployment review", async () => {
    h.get.mockResolvedValue({
      ...state(),
      clusterId: null,
      config: null,
      activeClusterId: null,
      status: null,
    });
    await render("server");
    await selectCluster("Production");
    await act(async () => host.querySelector<HTMLButtonElement>('[role="checkbox"]')!.click());
    expect(host.textContent).toContain("Image repository");
    expect(button("Review deployment").disabled).toBe(true);
    expect(h.set).not.toHaveBeenCalled();
  });
  it("saves a single-server destination without implying that running instances were stopped", async () => {
    h.set.mockResolvedValue({ ...state(), clusterId: null, config: null, serverId: null });
    await render();
    await selectCluster("This installation's server");
    await act(async () => button("Save destination").click());
    expect(h.set).toHaveBeenCalledWith("project", {
      clusterId: null,
      expectedUpdatedAt: state().updatedAt,
      stateless: true,
    });
    expect(h.deploy).not.toHaveBeenCalled();
    expect(h.scale).not.toHaveBeenCalled();
    expect(host.textContent).toContain("Running on Production");
    expect(h.update).toHaveBeenCalledWith(
      expect.objectContaining({ deployTarget: "local", serverId: null }),
    );
  });
  it.each(["postgres", "redis", "valkey"])(
    "keeps %s database replication separate from application instance controls",
    async (framework) => {
      await render("server", framework);
      expect(host.textContent).toContain("Database scaling");
      expect(host.querySelector('input[type="number"]')).toBeNull();
      expect(h.set).not.toHaveBeenCalled();
      expect(h.scale).not.toHaveBeenCalled();
    },
  );
});
