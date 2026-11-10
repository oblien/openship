import { describe, it, expect, vi } from "vitest";
import { DockerRuntime, type ContainerInfo } from "@repo/adapters";
import { verifyUnknownImageServices } from "./local-image-drift";

/**
 * The reported failure, at the orchestration level: a service whose active
 * row lost its `image_digest` read as "up to date" in the updates feed
 * because the registry comparison had nothing on the deployed side. The fix
 * asks the live daemon instead — the running container's image ID against
 * the image ID the configured tag resolves to right now — and only trusts
 * the answer the daemon can actually give.
 *
 * These tests drive the verifier with a stubbed Docker runtime (a real
 * instance shape, methods replaced) and a recording persist — no daemon,
 * no database.
 */
const OLD_IMAGE = "sha256:1111111111111111111111111111111111111111111111111111111111111111";
const NEW_IMAGE = "sha256:2222222222222222222222222222222222222222222222222222222222222222";
const REGISTRY_DIGEST = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const MOVED_DIGEST = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const TAG_REPO_DIGEST = `docker.io/library/nginx@${REGISTRY_DIGEST}`;

function service(overrides: Record<string, unknown> = {}) {
  return {
    serviceId: "svc-web",
    name: "web",
    ref: "nginx:alpine",
    deployedDigest: null as string | null,
    latestDigest: REGISTRY_DIGEST as string | null,
    behind: false,
    unknown: true,
    ...overrides,
  };
}

function stubRuntime(overrides: {
  containerImageId?: string | null;
  containerThrows?: boolean;
  tagImageId?: string | null;
  tagRegistryDigest?: string | null;
  tagThrows?: boolean;
  supportsContainerInfo?: boolean;
} = {}): DockerRuntime {
  const runtime = Object.create(DockerRuntime.prototype) as DockerRuntime;
  runtime.supports = () => overrides.supportsContainerInfo !== false;
  runtime.getContainerInfo = vi.fn(async (containerId: string): Promise<ContainerInfo> => {
    if (overrides.containerThrows) throw new Error("daemon unreachable");
    return {
      containerId,
      status: "running",
      ...(overrides.containerImageId ? { imageId: overrides.containerImageId } : {}),
    };
  });
  runtime.prepareDeploymentImage = vi.fn(async () => {
    if (overrides.tagThrows) throw new Error("tag not present on this daemon");
    return {
      imageId: overrides.tagImageId ?? NEW_IMAGE,
      deploymentRef: overrides.tagRegistryDigest ?? NEW_IMAGE,
      ...(overrides.tagRegistryDigest ? { registryDigest: overrides.tagRegistryDigest } : {}),
    };
  });
  return runtime;
}

const rows = [{ id: "sd-1", serviceId: "svc-web", containerId: "container-1" }];

describe("verifyUnknownImageServices", () => {
  it("marks a service behind when the container runs a different image from its tag", async () => {
    const svc = service();
    const persist = vi.fn(async () => {});
    await verifyUnknownImageServices(
      stubRuntime({ containerImageId: OLD_IMAGE, tagImageId: NEW_IMAGE }),
      rows,
      [svc],
      persist,
    );
    expect(svc.behind).toBe(true);
    expect(svc.unknown).toBe(false);
    // Nothing to heal: the running image is not what the tag points to.
    expect(persist).not.toHaveBeenCalled();
  });

  it("proves a service current and heals the row when the images and digests match", async () => {
    const svc = service();
    const persist = vi.fn(async () => {});
    await verifyUnknownImageServices(
      stubRuntime({
        containerImageId: NEW_IMAGE,
        tagImageId: NEW_IMAGE,
        tagRegistryDigest: TAG_REPO_DIGEST,
      }),
      rows,
      [svc],
      persist,
    );
    expect(svc.behind).toBe(false);
    expect(svc.unknown).toBe(false);
    expect(svc.deployedDigest).toBe(TAG_REPO_DIGEST);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledWith("sd-1", TAG_REPO_DIGEST);
  });

  it("marks behind when the registry moved the tag under a matching container", async () => {
    const svc = service({ latestDigest: MOVED_DIGEST });
    const persist = vi.fn(async () => {});
    await verifyUnknownImageServices(
      stubRuntime({
        containerImageId: NEW_IMAGE,
        tagImageId: NEW_IMAGE,
        tagRegistryDigest: TAG_REPO_DIGEST,
      }),
      rows,
      [svc],
      persist,
    );
    expect(svc.behind).toBe(true);
    expect(svc.unknown).toBe(false);
    expect(persist).toHaveBeenCalledWith("sd-1", TAG_REPO_DIGEST);
  });

  it("leaves the service unknown when the container cannot be inspected", async () => {
    const svc = service();
    const persist = vi.fn(async () => {});
    await verifyUnknownImageServices(
      stubRuntime({ containerThrows: true, tagImageId: NEW_IMAGE }),
      rows,
      [svc],
      persist,
    );
    expect(svc.behind).toBe(false);
    expect(svc.unknown).toBe(true);
    expect(persist).not.toHaveBeenCalled();
  });

  it("leaves the service unknown when the tag is not on the daemon", async () => {
    const svc = service();
    const persist = vi.fn(async () => {});
    await verifyUnknownImageServices(
      stubRuntime({ containerImageId: OLD_IMAGE, tagThrows: true }),
      rows,
      [svc],
      persist,
    );
    expect(svc.behind).toBe(false);
    expect(svc.unknown).toBe(true);
    expect(persist).not.toHaveBeenCalled();
  });

  it("leaves the service unknown when the images match but no digest exists anywhere", async () => {
    const svc = service({ latestDigest: null });
    const persist = vi.fn(async () => {});
    await verifyUnknownImageServices(
      stubRuntime({ containerImageId: NEW_IMAGE, tagImageId: NEW_IMAGE }),
      rows,
      [svc],
      persist,
    );
    expect(svc.behind).toBe(false);
    expect(svc.unknown).toBe(true);
    expect(persist).not.toHaveBeenCalled();
  });

  it("skips services with no container and never calls the runtime", async () => {
    const svc = service();
    const runtime = stubRuntime({ containerImageId: OLD_IMAGE, tagImageId: NEW_IMAGE });
    const persist = vi.fn(async () => {});
    await verifyUnknownImageServices(
      runtime,
      [{ id: "sd-1", serviceId: "svc-web", containerId: null }],
      [svc],
      persist,
    );
    expect(svc.behind).toBe(false);
    expect(svc.unknown).toBe(true);
    expect(runtime.getContainerInfo).not.toHaveBeenCalled();
    expect(runtime.prepareDeploymentImage).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
  });

  it("does nothing when the runtime has no container info", async () => {
    const svc = service();
    const persist = vi.fn(async () => {});
    await verifyUnknownImageServices(
      stubRuntime({ supportsContainerInfo: false }),
      rows,
      [svc],
      persist,
    );
    expect(svc.unknown).toBe(true);
    expect(persist).not.toHaveBeenCalled();
  });
});
