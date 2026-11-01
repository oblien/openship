// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClusterVolume } from "@repo/core";
import { ClusterVolumePanel } from "./ClusterVolumePanel";

const h = vi.hoisted(() => ({
  create: vi.fn(),
  list: vi.fn(),
  resize: vi.fn(),
  remove: vi.fn(),
  backup: vi.fn(),
  schedule: vi.fn(),
  storage: vi.fn(),
  project: vi.fn(),
  set: vi.fn(),
  saved: vi.fn(),
  refresh: vi.fn(),
  deploy: vi.fn(),
  updateProjectData: vi.fn(),
}));
vi.mock("@/lib/api/cluster-storage", () => ({
  clusterStorageApi: { get: h.storage },
  clusterVolumesApi: h,
}));
vi.mock("@/lib/api/project-cluster", () => ({ projectClusterApi: { get: h.project, set: h.set } }));
vi.mock("@/context/ProjectSettingsContext", () => ({
  useProjectSettings: () => ({ updateProjectData: h.updateProjectData }),
}));
const files = (name = "uploads"): ClusterVolume => ({
  name,
  resourceVersion: "7",
  sizeGiB: 5,
  phase: "Bound",
  state: "attached",
  robustness: "healthy",
  volumeName: "disk",
  message: null,
  copies: [],
  desiredCopies: 2,
  backups: [],
  backupSchedule: { frequency: "manual", retain: 7 },
});
let host: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  h.storage.mockResolvedValue({ status: "ready", config: { replicas: 2 } });
  h.project.mockResolvedValue({ updatedAt: "reviewed", config: { replicas: 2, mounts: [] } });
  h.refresh.mockResolvedValue(undefined);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
async function render(volume?: ClusterVolume, disabled = false) {
  await act(async () =>
    root.render(
      <ClusterVolumePanel
        projectId="project"
        clusterId="cluster"
        volume={volume}
        disabled={disabled}
        onSaved={h.saved}
        onRemoved={() => {}}
        onRefresh={h.refresh}
        onDeploy={h.deploy}
      />,
    ),
  );
}
const button = (label: string) =>
  [...host.querySelectorAll("button")].find((item) => item.textContent?.trim() === label)!;
const submit = () =>
  host
    .querySelector("form")!
    .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

describe("shared-file workflow", () => {
  it("locks duplicate submissions and describes the outcome without an installation framework", async () => {
    let done!: (volume: ClusterVolume) => void;
    h.create.mockReturnValue(
      new Promise((resolve) => {
        done = resolve;
      }),
    );
    await render();
    expect(host.textContent).toContain("shared folder");
    expect(host.textContent).not.toMatch(/Longhorn|Kubernetes|K3s|CSI/);
    await act(async () => {
      submit();
      submit();
    });
    expect(h.create).toHaveBeenCalledOnce();
    expect(button("Create shared volume").disabled).toBe(true);
    await act(async () => done(files()));
    expect(h.saved).toHaveBeenCalledWith(files());
    expect(h.deploy).not.toHaveBeenCalled();
  });
  it("reads status after a lost response and reuses the request only on an explicit retry", async () => {
    h.create
      .mockRejectedValueOnce(new Error("Connection interrupted"))
      .mockResolvedValueOnce(files());
    await render();
    await act(async () => {
      submit();
    });
    expect(h.create).toHaveBeenCalledOnce();
    expect(h.refresh).toHaveBeenCalledOnce();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Connection interrupted");
    await act(async () => {
      submit();
    });
    expect(h.create).toHaveBeenCalledTimes(2);
    expect(h.create.mock.calls[0][1].requestId).toBe(h.create.mock.calls[1][1].requestId);
  });
  it("saves an application folder and opens deployment review", async () => {
    h.set.mockResolvedValue({
      updatedAt: "new",
      config: {
        replicas: 2,
        mounts: [{ name: "uploads", mountPath: "/app/uploads", readOnly: false }],
      },
    });
    await render(files());
    await act(async () => button("Attach & review deployment").click());
    expect(h.set).toHaveBeenCalledWith("project", {
      clusterId: "cluster",
      stateless: true,
      expectedUpdatedAt: "reviewed",
      config: {
        replicas: 2,
        mounts: [{ name: "uploads", mountPath: "/app/uploads", readOnly: false }],
      },
    });
    expect(h.deploy).toHaveBeenCalledOnce();
    expect(h.remove).not.toHaveBeenCalled();
  });
  it("does not claim uncertain storage is healthy and resets fields when another volume is opened", async () => {
    await render({ ...files(), robustness: "unknown", state: "attaching" });
    expect(host.textContent).toContain("Preparing storage");
    expect(host.textContent).not.toContain("Files available");
    await render(files("assets"));
    expect(host.querySelector<HTMLInputElement>('input[placeholder="/app/uploads"]')?.value).toBe(
      "/app/assets",
    );
    expect(h.create).not.toHaveBeenCalled();
  });
  it("keeps destructive and application changes disabled in a read-only view", async () => {
    await render(files(), true);
    expect(button("Attach & review deployment").disabled).toBe(true);
    expect(button("Delete volume").disabled).toBe(true);
  });
});
