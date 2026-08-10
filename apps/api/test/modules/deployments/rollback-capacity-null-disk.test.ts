/**
 * D9: a failed disk probe persisted a fabricated `auto` window.
 *
 * `refreshRollbackCapacity` wrote whatever `computeAutoRollbackWindow` returned,
 * and that function returns the INSTANCE DEFAULT when it can't measure. Writing
 * it into `rollbackWindowComputed` — documented "null = never measured" — makes
 * `resolveRollbackWindowDetail` answer `source: "auto"` from then on, so the
 * `instance-default` branch becomes permanently unreachable for that project and
 * a later change to `instance_settings.default_rollback_window` silently stops
 * applying to it. One unreachable host during one deploy was enough.
 */

import { repos } from "@repo/db";
import { beforeEach, describe, expect, it } from "vitest";

import {
  refreshRollbackCapacity,
  resolveRollbackWindowDetail,
} from "../../../src/modules/deployments/release-retention";
import { seedOrg, seedProject } from "../../helpers/seed";

const MB = 1024 * 1024;
const GB = 1024 * MB;

describe("refreshRollbackCapacity with no readable disk", () => {
  let projectId: string;

  beforeEach(async () => {
    const org = await seedOrg();
    projectId = (await seedProject(org.organizationId)).id;
    await repos.instanceSettings.upsert({ defaultRollbackWindow: 4 });
  });

  const reload = async () => (await repos.project.findById(projectId))!;

  it("keeps the measured snapshot size but claims no window", async () => {
    await refreshRollbackCapacity({
      projectId,
      imageSizes: [200 * MB, 400 * MB],
      diskFreeBytes: null,
      instanceDefault: 4,
    });

    const project = await reload();
    // The size IS measured, and it's what lets the next successful probe size
    // anything at all — so it's persisted.
    expect(project.snapshotSizeBytes).toBe(300 * MB);
    expect(project.rollbackWindowComputed).toBeNull();
    expect(project.capacityMeasuredAt).toBeNull();

    const detail = await resolveRollbackWindowDetail(project);
    expect(detail.source).toBe("instance-default");
    expect(detail.window).toBe(4);
  });

  it("still tracks the instance default afterwards", async () => {
    // The actual damage: once `rollbackWindowComputed` is set, the operator's
    // instance-wide setting stops reaching this project forever.
    await refreshRollbackCapacity({
      projectId,
      imageSizes: [300 * MB],
      diskFreeBytes: null,
      instanceDefault: 4,
    });
    await repos.instanceSettings.upsert({ defaultRollbackWindow: 9 });

    expect((await resolveRollbackWindowDetail(await reload())).window).toBe(9);
  });

  it("treats a zero-byte reading as unmeasured", async () => {
    // `df` returning 0 free is either a parse artifact or a full disk; neither
    // is a figure to size a retention target from.
    await refreshRollbackCapacity({
      projectId,
      imageSizes: [300 * MB],
      diskFreeBytes: 0,
      instanceDefault: 4,
    });
    expect((await reload()).rollbackWindowComputed).toBeNull();
  });

  it("writes the auto window when the disk IS readable", async () => {
    await refreshRollbackCapacity({
      projectId,
      imageSizes: [1 * GB],
      diskFreeBytes: 40 * GB,
      instanceDefault: 4,
    });

    const project = await reload();
    // 25% of 40 GiB = 10 GiB budget / 1 GiB per release.
    expect(project.rollbackWindowComputed).toBe(10);
    expect(project.capacityMeasuredAt).toBeInstanceOf(Date);

    const detail = await resolveRollbackWindowDetail(project);
    expect(detail.source).toBe("auto");
    expect(detail.window).toBe(10);
  });

  it("leaves an explicit override untouched either way", async () => {
    await repos.project.update(projectId, { rollbackWindow: 2 });
    await refreshRollbackCapacity({
      projectId,
      imageSizes: [300 * MB],
      diskFreeBytes: null,
      instanceDefault: 4,
    });

    const detail = await resolveRollbackWindowDetail(await reload());
    expect(detail.source).toBe("explicit");
    expect(detail.window).toBe(2);
  });
});
