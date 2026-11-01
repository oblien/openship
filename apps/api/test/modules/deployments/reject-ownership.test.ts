import { describe, expect, it, vi } from "vitest";
import { repos } from "@repo/db";
import { seedOrg, seedProject, seedDeployment } from "../../helpers/seed";

const h = vi.hoisted(() => ({ rollback: vi.fn(), cleanup: vi.fn() }));
vi.mock("@repo/platform/engine/modules/deployments/rollback/index", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  rollback: h.rollback,
}));
vi.mock("@repo/platform/engine/modules/projects/project-cleanup.service", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  executeCleanup: h.cleanup,
}));

const { rejectDeployment } =
  await import("@repo/platform/engine/modules/deployments/deployment.service");
const { computeCleanupKeepSet } =
  await import("@repo/platform/engine/modules/projects/cleanup-keep-set");

describe("rollback predecessor ownership", () => {
  it.each([false, true])(
    "refuses a predecessor from another project (different organization: %s) before any runtime action",
    async (differentOrg) => {
      h.rollback.mockClear();
      h.cleanup.mockClear();
      const org = await seedOrg();
      const otherOrg = differentOrg ? await seedOrg() : org;
      const project = await seedProject(org.organizationId, { rollbackWindow: 0 });
      const otherProject = await seedProject(otherOrg.organizationId);
      const foreign = await seedDeployment(otherProject, {
        containerId: "foreign-container",
        imageRef: "foreign:image",
      });
      const rejected = await seedDeployment(project, {
        meta: { previousActiveDeploymentId: foreign.id },
      });

      await expect(rejectDeployment(rejected.id, org.organizationId)).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
      expect(h.rollback).not.toHaveBeenCalled();
      expect(h.cleanup).not.toHaveBeenCalled();
      expect((await repos.deployment.findById(rejected.id))?.status).toBe("ready");
      expect((await repos.deployment.findById(foreign.id))?.status).toBe("ready");

      const keep = await computeCleanupKeepSet(project, { alsoProtectDeploymentId: foreign.id });
      expect(keep.containers.has("foreign-container")).toBe(false);
      expect(keep.images.has("foreign:image")).toBe(false);
    },
  );
});
