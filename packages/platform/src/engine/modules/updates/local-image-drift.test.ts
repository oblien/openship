import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DockerRuntime, type ContainerInfo } from "@repo/adapters";
import type { Project } from "@repo/db";

const h = vi.hoisted(() => ({
  findDeployment: vi.fn(),
  listServices: vi.fn(),
  write: vi.fn(),
  withRuntime: vi.fn(),
}));
vi.mock("@repo/db", () => ({
  repos: {
    deployment: { findById: h.findDeployment },
    service: { listByDeployment: h.listServices, updateServiceDeployment: h.write },
  },
}));
vi.mock("../../lib/deployment-runtime", () => ({ withDeploymentRuntime: h.withRuntime }));

import { verifyUnknownImageDrift, verifyUnknownImageServices } from "./local-image-drift";

const oldImage = `sha256:${"1".repeat(64)}`;
const newImage = `sha256:${"2".repeat(64)}`;
const oldDigest = `docker.io/library/nginx@sha256:${"a".repeat(64)}`;
const newDigest = `sha256:${"b".repeat(64)}`;
const project = {
  id: "project-a",
  organizationId: "org-a",
  activeDeploymentId: "dep-a",
} as Project;
const service = (id = "svc-a") => ({
  serviceId: id,
  name: id,
  ref: "nginx:alpine",
  deployedDigest: null as string | null,
  latestDigest: newDigest as string | null,
  behind: false,
  unknown: true,
});
const rows = [{ serviceId: "svc-a", containerId: "container-a" }];
function runtime() {
  const instance = Object.create(DockerRuntime.prototype) as DockerRuntime;
  instance.supports = vi.fn(() => true);
  instance.getContainerInfo = vi.fn(
    async (containerId: string): Promise<ContainerInfo> => ({
      containerId,
      status: "running",
      imageId: oldImage,
    }),
  );
  instance.prepareDeploymentImage = vi.fn(async () => ({
    imageId: newImage,
    deploymentRef: newImage,
  }));
  instance.resolveImageDigest = vi.fn(async () => undefined);
  instance.pullImage = vi.fn();
  return instance;
}
const status = () => ({
  supported: true as const,
  mode: "image" as const,
  behind: false,
  latestInProgress: false,
  inProgressDeploymentId: null,
  unverified: true,
  services: [service()],
});

beforeEach(() => {
  vi.resetAllMocks();
  h.findDeployment.mockResolvedValue({
    id: "dep-a",
    projectId: "project-a",
    organizationId: "org-a",
  });
  h.listServices.mockResolvedValue(rows);
});
afterEach(() => vi.useRealTimers());

describe("local image drift observations", () => {
  it("detects the reported untagged-container/local-retag case without pulls or writes", async () => {
    const observed = service();
    const docker = runtime();
    await verifyUnknownImageServices(docker, rows, [observed]);
    expect(observed).toMatchObject({ behind: true, unknown: false, deployedDigest: null });
    expect(docker.prepareDeploymentImage).toHaveBeenCalledExactlyOnceWith("nginx:alpine", {
      requirePresent: true,
    });
    expect(docker.resolveImageDigest).toHaveBeenCalledWith(oldImage, "nginx:alpine");
    expect(docker.pullImage).not.toHaveBeenCalled();
    expect(h.write).not.toHaveBeenCalled();
  });

  it("recovers running-image evidence in memory when the tag is absent locally", async () => {
    const observed = service();
    const docker = runtime();
    vi.mocked(docker.prepareDeploymentImage).mockRejectedValue(new Error("tag not found"));
    vi.mocked(docker.resolveImageDigest).mockResolvedValue(oldDigest);
    await verifyUnknownImageServices(docker, rows, [observed]);
    expect(observed).toMatchObject({ behind: true, unknown: false, deployedDigest: oldDigest });
    expect(h.write).not.toHaveBeenCalled();
  });

  it("does not call a matching local image current when the registry is unknown", async () => {
    const observed = { ...service(), latestDigest: null };
    const docker = runtime();
    vi.mocked(docker.prepareDeploymentImage).mockResolvedValue({
      imageId: oldImage,
      deploymentRef: oldDigest,
      registryDigest: oldDigest,
    });
    await verifyUnknownImageServices(docker, rows, [observed]);
    expect(observed).toMatchObject({ behind: false, unknown: true, deployedDigest: oldDigest });
  });

  it("deduplicates shared-tag inspection across services", async () => {
    const docker = runtime();
    await verifyUnknownImageServices(
      docker,
      [...rows, { serviceId: "svc-b", containerId: "container-b" }],
      [service(), service("svc-b")],
    );
    expect(docker.prepareDeploymentImage).toHaveBeenCalledTimes(1);
    expect(docker.getContainerInfo).toHaveBeenCalledTimes(2);
  });

  it("skips a tag lookup when container ownership or inspection fails", async () => {
    const observed = service();
    const docker = runtime();
    vi.mocked(docker.getContainerInfo).mockRejectedValue(new Error("not owned"));
    await verifyUnknownImageServices(docker, rows, [observed]);
    expect(observed).toMatchObject({ behind: false, unknown: true });
    expect(docker.prepareDeploymentImage).not.toHaveBeenCalled();
    expect(docker.resolveImageDigest).not.toHaveBeenCalled();
  });

  it("bounds a stalled inspection and ignores its late result", async () => {
    vi.useFakeTimers();
    const observed = service();
    const docker = runtime();
    let complete!: (value: Awaited<ReturnType<DockerRuntime["getContainerInfo"]>>) => void;
    vi.mocked(docker.getContainerInfo).mockReturnValue(
      new Promise((resolve) => {
        complete = resolve;
      }),
    );
    const pending = verifyUnknownImageServices(docker, rows, [observed]);
    await vi.advanceTimersByTimeAsync(3_001);
    await pending;
    complete({ containerId: "container-a", status: "running", imageId: oldImage });
    await Promise.resolve();
    expect(observed).toMatchObject({ behind: false, unknown: true });
    expect(docker.prepareDeploymentImage).not.toHaveBeenCalled();
  });
});

describe("runtime resolution and authority", () => {
  it("rejects a foreign active pointer before resolving a runtime", async () => {
    h.findDeployment.mockResolvedValue({
      id: "dep-a",
      projectId: "project-a",
      organizationId: "org-b",
    });
    await verifyUnknownImageDrift(project, status());
    expect(h.listServices).not.toHaveBeenCalled();
    expect(h.withRuntime).not.toHaveBeenCalled();
  });

  it("does not acquire a transport without a recorded container", async () => {
    h.listServices.mockResolvedValue([{ serviceId: "svc-a", containerId: null }]);
    await verifyUnknownImageDrift(project, status());
    expect(h.withRuntime).not.toHaveBeenCalled();
  });

  it("uses the shared runtime wrapper and recomputes aggregate state", async () => {
    const result = status();
    h.withRuntime.mockImplementation(async (_deployment, work) => work(runtime()));
    await verifyUnknownImageDrift(project, result);
    expect(h.withRuntime).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: "org-a", projectId: "project-a" }),
      expect.any(Function),
    );
    expect(result).toMatchObject({ behind: true, unverified: false });
    expect(h.write).not.toHaveBeenCalled();
  });

  it("performs no inspection when a runtime resolves after the response deadline", async () => {
    vi.useFakeTimers();
    const docker = runtime();
    let release!: () => void;
    h.withRuntime.mockImplementation(async (_deployment, work) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return work(docker);
    });
    const result = status();
    const pending = verifyUnknownImageDrift(project, result);
    await vi.advanceTimersByTimeAsync(3_001);
    await pending;
    release();
    await Promise.resolve();
    await Promise.resolve();
    expect(docker.getContainerInfo).not.toHaveBeenCalled();
    expect(result).toMatchObject({ behind: false, unverified: true });
  });
});
