import { repos } from "@repo/db";
import { beforeEach, describe, expect, it } from "vitest";
import { env } from "@repo/platform/engine/config/env";
import {
  refreshRollbackCapacity,
  resolveRollbackWindowDetail,
} from "@repo/platform/engine/modules/deployments/release-retention";
import { seedOrg, seedProject } from "../../helpers/seed";

const MB = 1024 * 1024;

describe("the configured rollback limit survives measurements and upgrades", () => {
  let projectId: string;
  const reload = async () => (await repos.project.findById(projectId))!;

  beforeEach(async () => {
    const org = await seedOrg();
    projectId = (await seedProject(org.organizationId)).id;
    await repos.instanceSettings.delete();
  });

  it("defaults to two past releases with or without a settings row", async () => {
    expect(await resolveRollbackWindowDetail(await reload())).toMatchObject({ window: 2, source: "instance-default" });
    const settings = await repos.instanceSettings.upsert({ authMode: "local" });
    expect(settings.defaultRollbackWindow).toBe(2);
    expect(await resolveRollbackWindowDetail(await reload())).toMatchObject({ window: 2, source: "instance-default" });
  });

  it("uses the Cloud default for existing projects and honors their overrides", async () => {
    const cloudMode = env.CLOUD_MODE;
    try {
      env.CLOUD_MODE = true;
      await repos.instanceSettings.upsert({ defaultRollbackWindow: 5 });
      expect(await resolveRollbackWindowDetail(await reload())).toMatchObject({ window: 2, source: "instance-default" });
      await repos.project.update(projectId, { rollbackWindow: 5 });
      expect(await resolveRollbackWindowDetail(await reload())).toMatchObject({ window: 5, source: "explicit" });
    } finally {
      env.CLOUD_MODE = cloudMode;
    }
  });

  it("does not revive an old disk-sized limit after upgrading", async () => {
    await repos.project.update(projectId, { rollbackWindowComputed: 20 });
    await refreshRollbackCapacity({ projectId, imageSizes: [200 * MB, 400 * MB] });
    const project = await reload();
    expect(project.snapshotSizeBytes).toBe(300 * MB);
    expect(project.capacityMeasuredAt).toBeInstanceOf(Date);
    expect(await resolveRollbackWindowDetail(project)).toMatchObject({ window: 2, source: "instance-default" });
  });

  it("keeps following a deliberately changed instance default", async () => {
    await refreshRollbackCapacity({ projectId, imageSizes: [300 * MB] });
    await repos.instanceSettings.upsert({ defaultRollbackWindow: 5 });
    expect(await resolveRollbackWindowDetail(await reload())).toMatchObject({ window: 5, source: "instance-default" });
  });

  it.each([0, 2, 20])("honors the explicit limit %i after measuring", async (window) => {
    await repos.project.update(projectId, { rollbackWindow: window });
    await refreshRollbackCapacity({ projectId, imageSizes: [300 * MB] });
    expect(await resolveRollbackWindowDetail(await reload())).toMatchObject({ window, source: "explicit" });
  });

  it("does not invent a measurement when every image size is invalid", async () => {
    await refreshRollbackCapacity({ projectId, imageSizes: [0, -1, NaN, Infinity] });
    expect((await reload()).snapshotSizeBytes).toBeNull();
    expect((await reload()).capacityMeasuredAt).toBeNull();
  });
});
