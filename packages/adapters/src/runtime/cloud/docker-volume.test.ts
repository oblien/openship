import { describe, expect, it, vi } from "vitest";
import { ensureCloudProjectVolume, resolveCloudProjectVolumeName } from "./docker-volume";

type Volume = { Labels?: Record<string, string> };
type Container = { Labels: Record<string, string>; Mounts: Array<{ Type: string; Name: string }> };

function fixture(initial: Record<string, Volume> = {}, containers: Container[] = []) {
  const volumes = new Map(Object.entries(initial));
  const createVolume = vi.fn(async (input: { Name: string; Labels: Record<string, string> }) => {
    if (!volumes.has(input.Name)) volumes.set(input.Name, { Labels: input.Labels });
  });
  const getVolume = vi.fn((name: string) => ({
    inspect: async () => {
      const volume = volumes.get(name);
      if (!volume) throw Object.assign(new Error("missing volume"), { statusCode: 404 });
      return volume;
    },
  }));
  const docker = { getVolume, createVolume, listContainers: vi.fn(async () => containers) };
  return { docker: docker as never, volumes, createVolume, getVolume };
}

describe("Cloud project volume identity", () => {
  it("gives different projects with the same app slug separate stable volumes", async () => {
    const f = fixture();
    const first = await resolveCloudProjectVolumeName(
      f.docker,
      "project-a",
      "wordpress",
      "wordpress_db_data",
    );
    const second = await resolveCloudProjectVolumeName(
      f.docker,
      "project-b",
      "wordpress",
      "wordpress_db_data",
    );
    expect(first).not.toBe(second);
    await ensureCloudProjectVolume(f.docker, first, "project-a");
    await ensureCloudProjectVolume(f.docker, second, "project-b");
    expect(
      await resolveCloudProjectVolumeName(f.docker, "project-a", "renamed", "wordpress_db_data"),
    ).toBe(first);
    expect(f.volumes.get(first)?.Labels?.["openship.project"]).toBe("project-a");
    expect(f.volumes.get(second)?.Labels?.["openship.project"]).toBe("project-b");
    expect(await resolveCloudProjectVolumeName(f.docker, "project-a", "wordpress", first)).toBe(
      first,
    );
  });

  it("reuses an owned legacy volume without creating or replacing its data", async () => {
    const volume = { Labels: { "openship.project": "project-a" } };
    const f = fixture({ "openship-wordpress-wordpress_db_data": volume });
    const name = await resolveCloudProjectVolumeName(
      f.docker,
      "project-a",
      "wordpress",
      "wordpress_db_data",
    );
    expect(name).toBe("openship-wordpress-wordpress_db_data");
    await ensureCloudProjectVolume(f.docker, name, "project-a");
    expect(f.volumes.get(name)).toBe(volume);
    expect(f.createVolume).not.toHaveBeenCalled();
  });

  it.each([{}, { Labels: { "openship.project": "project-b" } }])(
    "leaves unowned legacy storage untouched for a fresh installation (%j)",
    async (volume) => {
      const legacy = "openship-wordpress-wordpress_db_data";
      const f = fixture({ [legacy]: volume });
      const name = await resolveCloudProjectVolumeName(
        f.docker,
        "project-a",
        "wordpress",
        "wordpress_db_data",
      );
      expect(name).not.toBe(legacy);
      await ensureCloudProjectVolume(f.docker, name, "project-a");
      expect(f.volumes.get(legacy)).toBe(volume);
      expect(f.volumes.get(name)?.Labels?.["openship.project"]).toBe("project-a");
    },
  );

  it("refuses to switch an existing project's disputed mount to an empty database", async () => {
    const legacy = "openship-wordpress-wordpress_db_data";
    const f = fixture({ [legacy]: {} }, [
      {
        Labels: { "openship.project": "project-a" },
        Mounts: [{ Type: "volume", Name: legacy }],
      },
    ]);
    await expect(
      resolveCloudProjectVolumeName(f.docker, "project-a", "wordpress", "wordpress_db_data"),
    ).rejects.toMatchObject({ code: "CLOUD_VOLUME_CONFLICT" });
    expect(f.createVolume).not.toHaveBeenCalled();
    expect(f.volumes.size).toBe(1);
  });

  it("keeps a persisted import name and rejects a foreign concrete volume instead of redirecting it", async () => {
    const name = "openship-wordpress-imported_data";
    const f = fixture({ [name]: { Labels: { "openship.project": "project-b" } } });
    expect(await resolveCloudProjectVolumeName(f.docker, "project-a", "wordpress", name)).toBe(
      name,
    );
    await expect(ensureCloudProjectVolume(f.docker, name, "project-a")).rejects.toMatchObject({
      code: "CLOUD_VOLUME_CONFLICT",
    });
    expect(f.createVolume).not.toHaveBeenCalled();
  });

  it("checks persisted ownership after a concurrent create wins the same name", async () => {
    const f = fixture();
    const name = await resolveCloudProjectVolumeName(f.docker, "project-a", "wordpress", "data");
    f.createVolume.mockImplementationOnce(async (input) => {
      f.volumes.set(input.Name, { Labels: { "openship.project": "project-b" } });
    });
    await expect(ensureCloudProjectVolume(f.docker, name, "project-a")).rejects.toMatchObject({
      code: "CLOUD_VOLUME_CONFLICT",
    });
    expect(f.volumes.get(name)?.Labels?.["openship.project"]).toBe("project-b");
  });

  it("propagates Docker inspection failures instead of treating unavailable storage as absent", async () => {
    const f = fixture();
    const error = Object.assign(new Error("Docker unavailable"), { statusCode: 503 });
    f.getVolume.mockImplementationOnce(() => ({
      inspect: async () => {
        throw error;
      },
    }));
    await expect(
      resolveCloudProjectVolumeName(f.docker, "project-a", "wordpress", "data"),
    ).rejects.toBe(error);
    expect(f.createVolume).not.toHaveBeenCalled();
  });
});
