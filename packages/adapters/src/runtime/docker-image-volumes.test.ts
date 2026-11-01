import { describe, expect, it, vi } from "vitest";
import type Dockerode from "dockerode";
import { resolveImageVolumeBinds } from "./docker-image-volumes";

const missing = () => Object.assign(new Error("Not found"), { statusCode: 404 });
const owner = { projectId: "project-a", workload: "app" };

function daemon() {
  const volumes = new Map<string, { Labels: Record<string, string> }>();
  const containers = new Map<string, unknown>();
  const docker = {
    getContainer: vi.fn((id: string) => ({
      inspect: vi.fn(async () => {
        if (!containers.has(id)) throw missing();
        return containers.get(id);
      }),
    })),
    getVolume: vi.fn((name: string) => ({
      inspect: vi.fn(async () => {
        if (!volumes.has(name)) throw missing();
        return volumes.get(name);
      }),
    })),
    createVolume: vi.fn(async (config: { Name: string; Labels: Record<string, string> }) => {
      if (!volumes.has(config.Name)) volumes.set(config.Name, { Labels: config.Labels });
    }),
  };
  const resolve = (
    declared: string[],
    image: string[],
    input = owner as Parameters<typeof resolveImageVolumeBinds>[3],
  ) => resolveImageVolumeBinds(docker as unknown as Dockerode, declared, image, input);
  const legacy = (labels = { "openship.project": "project-a", "openship.deployment": "old" }) => {
    volumes.set("old-anonymous-volume", { Labels: {} });
    containers.set("old-container", {
      Config: { Labels: labels },
      Mounts: [{ Type: "volume", Name: "old-anonymous-volume", Destination: "/data", RW: true }],
    });
    return { ...owner, previous: { containerId: "old-container" } };
  };
  return { docker, volumes, containers, resolve, legacy };
}

describe("image-declared persistent volumes", () => {
  it("uses one owned volume across rebuilds and normalized destinations", async () => {
    const { resolve, docker, volumes } = daemon();
    const first = await resolve([], ["/app/data/"]);
    expect(await resolve([], ["/app/data"])).toEqual(first);
    expect(first[0]).toMatch(/^openship-project-[a-f0-9]+-data-[a-f0-9]+:\/app\/data$/);
    expect(docker.createVolume).toHaveBeenCalledOnce();
    expect([...volumes.values()]).toEqual([{ Labels: { "openship.project": "project-a" } }]);
  });

  it("isolates projects and services even when destination and slug would match", async () => {
    const { resolve } = daemon();
    const a = await resolve([], ["/data"]);
    const b = await resolve([], ["/data"], { ...owner, projectId: "project-b" });
    const c = await resolve([], ["/data"], { ...owner, workload: "database" });
    expect(new Set([...a, ...b, ...c]).size).toBe(3);
  });

  it("keeps explicit named and host binds, including their options", async () => {
    const { resolve, docker } = daemon();
    expect(
      await resolve(["chosen:/data:ro,nocopy", "/srv/media:/media"], ["/data/", "/media"], {
        ...owner,
        previous: { containerId: "missing" },
      }),
    ).toEqual(["chosen:/data:ro,nocopy", "/srv/media:/media"]);
    expect(docker.getContainer).not.toHaveBeenCalled();
    expect(docker.createVolume).not.toHaveBeenCalled();
  });

  it("makes path-only mounts persistent and deduplicates image declarations", async () => {
    const { resolve, docker } = daemon();
    const result = await resolve(["/data:ro"], ["/data"]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatch(/:\/data:ro$/);
    expect(docker.createVolume).toHaveBeenCalledOnce();
  });

  it("reattaches the exact legacy volume without copying, renaming or creating storage", async () => {
    const { resolve, docker, legacy } = daemon();
    expect(await resolve([], ["/data"], legacy())).toEqual(["old-anonymous-volume:/data"]);
    expect(docker.createVolume).not.toHaveBeenCalled();
  });

  it("retains a legacy mount across a changed release identity and preserves read-only mode", async () => {
    const { resolve, legacy, containers } = daemon();
    const input = legacy();
    (containers.get("old-container") as any).Mounts[0].RW = false;
    expect(await resolve([], ["/data"], input)).toEqual(["old-anonymous-volume:/data:ro"]);
  });

  it("preserves deployed workload storage when its source image also carries a build label", async () => {
    const { resolve, legacy, docker } = daemon();
    const input = legacy({
      "openship.project": "project-a",
      "openship.deployment": "old",
      "openship.build": "inherited-image-build",
    } as any);
    expect(await resolve([], ["/data"], input)).toEqual(["old-anonymous-volume:/data"]);
    expect(docker.createVolume).not.toHaveBeenCalled();
  });

  it.each([
    { "openship.project": "other" },
    { "openship.project": "project-a", "openship.role": "worker" },
    { "openship.project": "project-a", "openship.build": "build-1" },
    {},
  ])("rejects a container with unverified workload ownership: %j", async (labels) => {
    const { resolve, legacy, docker } = daemon();
    await expect(resolve([], ["/data"], legacy(labels as any))).rejects.toThrow("ownership");
    expect(docker.createVolume).not.toHaveBeenCalled();
  });

  it("rejects another service's mounts within the same project", async () => {
    const { resolve, legacy, docker } = daemon();
    const input = legacy({ "openship.project": "project-a", "openship.service": "other" } as any);
    await expect(
      resolve([], ["/data"], {
        ...input,
        previous: { ...input.previous, serviceName: "database" },
      }),
    ).rejects.toThrow("ownership");
    expect(docker.createVolume).not.toHaveBeenCalled();
  });

  it("fails closed for a missing recorded container, but permits an absent first-deploy name", async () => {
    const { resolve, docker } = daemon();
    await expect(
      resolve([], ["/data"], {
        ...owner,
        previous: { containerId: "missing" },
      }),
    ).rejects.toThrow("Recover its persistent volume mapping");
    expect(docker.createVolume).not.toHaveBeenCalled();
    expect(
      await resolve([], ["/data"], {
        ...owner,
        previous: { containerId: "new-service", required: false },
      }),
    ).toHaveLength(1);
  });

  it("does not mask daemon failures as empty inventory", async () => {
    const { resolve, legacy, docker } = daemon();
    docker.getContainer.mockImplementation(() => ({
      inspect: vi.fn(async () => {
        throw new Error("SSH unavailable");
      }),
    }));
    await expect(resolve([], ["/data"], legacy())).rejects.toThrow("SSH unavailable");
    expect(docker.createVolume).not.toHaveBeenCalled();
  });

  it("does not replace a missing legacy volume with an empty one", async () => {
    const { resolve, legacy, docker, volumes } = daemon();
    const input = legacy();
    volumes.clear();
    await expect(resolve([], ["/new", "/data"], input)).rejects.toThrow("Not found");
    expect(docker.createVolume).not.toHaveBeenCalled();
  });

  it("rejects a legacy mount whose volume is explicitly owned by another project", async () => {
    const { resolve, legacy, volumes } = daemon();
    const input = legacy();
    volumes.set("old-anonymous-volume", { Labels: { "openship.project": "other" } });
    await expect(resolve([], ["/data"], input)).rejects.toThrow("another project");
  });

  it("does not adopt a conflicting generated volume, including a creation race", async () => {
    const { resolve, volumes, docker } = daemon();
    const [bind] = await resolve([], ["/data"]);
    const name = bind!.split(":")[0]!;
    volumes.set(name, { Labels: { "openship.project": "other" } });
    await expect(resolve([], ["/data"])).rejects.toThrow("another project");
    volumes.clear();
    docker.createVolume.mockImplementation(async ({ Name }) => {
      volumes.set(Name, { Labels: { "openship.project": "other" } });
    });
    await expect(resolve([], ["/data"])).rejects.toThrow("another project");
  });

  it("requires explicit configuration for an old host bind", async () => {
    const { resolve, legacy, containers } = daemon();
    const input = legacy();
    (containers.get("old-container") as any).Mounts[0].Type = "bind";
    await expect(resolve([], ["/data"], input)).rejects.toThrow("Configure the existing mount");
  });

  it("does nothing for images without volumes", async () => {
    const { resolve, docker } = daemon();
    expect(await resolve([], [])).toEqual([]);
    expect(docker.getContainer).not.toHaveBeenCalled();
    expect(docker.createVolume).not.toHaveBeenCalled();
  });
});
