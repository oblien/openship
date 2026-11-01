import type { SecurityAdvisory } from "@repo/core";
import notices from "../../../../../security-advisories.json";
const advisories = notices.advisories as SecurityAdvisory[];

import { beforeEach, describe, expect, it, vi } from "vitest";
import { repos, seedOwner } from "../jobs/_harness";
import { projectSecurityInventory } from "@repo/platform/engine/modules/updates/security-inventory";
import { buildBackgroundContext } from "@repo/platform/engine/lib/background-context";

const h = vi.hoisted(() => ({
  resolve: vi.fn(),
  dispose: vi.fn(),
  container: vi.fn(),
  exec: vi.fn(),
  isolated: true,
}));
vi.mock("@repo/platform/engine/lib/deployment-runtime", async (original) => ({
  ...(await original<object>()),
  resolveDeploymentRuntimeForRead: h.resolve,
  disposeRuntime: h.dispose,
}));
vi.mock("@repo/platform/engine/modules/services/service-container", async (original) => ({
  ...(await original<object>()),
  liveContainerIdWithRuntime: h.container,
}));
beforeEach(() => {
  h.isolated = true;
  h.resolve.mockReset().mockImplementation(async () => ({
    runtime: {
      supports: (capability: string) => capability === "isolatedExec" && h.isolated,
      inContainerExecutor: async () => ({ exec: h.exec }),
    },
  }));
  h.container.mockReset().mockResolvedValue("owned-container");
  h.exec.mockReset().mockResolvedValue("OPENSHIP_RUNTIME_node\nv22.23.3\n");
  h.dispose.mockClear();
});
async function fixture() {
  const owner = await seedOwner();
  const group = await repos.projectGroup.create({
    organizationId: owner.orgId,
    name: "Inventory",
    slug: owner.userId,
  });
  const project = await repos.project.create({
    organizationId: owner.orgId,
    groupId: group.id,
    name: "Inventory",
    slug: owner.userId,
    runtimeMode: "docker",
    framework: "docker-compose",
  });
  const service = await repos.service.create({
    projectId: project.id,
    name: "web",
    image: "node:22",
  });
  const deployment = await repos.deployment.create({
    organizationId: owner.orgId,
    projectId: project.id,
    branch: "main",
    status: "ready",
    meta: { runtimeMode: "docker" },
  });
  await repos.project.update(project.id, { activeDeploymentId: deployment.id });
  const ctx = buildBackgroundContext({ userId: owner.userId, organizationId: owner.orgId });
  return { owner, project, service, deployment, ctx };
}
describe("scoped runtime inventory", () => {
  it("coalesces concurrent reads, caches observations and rejects foreign workspaces", async () => {
    const f = await fixture(),
      other = await fixture();
    const results = await Promise.all(
      Array.from({ length: 5 }, () => projectSecurityInventory(f.ctx, f.project.id, advisories)),
    );
    expect(results[0].runtimes).toEqual([
      { runtime: "node", version: "22.23.3", serviceId: f.service.id },
    ]);
    expect(h.exec).toHaveBeenCalledTimes(1);
    await projectSecurityInventory(f.ctx, f.project.id, advisories);
    expect(h.exec).toHaveBeenCalledTimes(1);
    await expect(projectSecurityInventory(other.ctx, f.project.id, advisories)).rejects.toThrow();
    expect(h.exec).toHaveBeenCalledTimes(1);
  });
  it("inspects only on rule/deployment changes or an explicit check, not elapsed time", async () => {
    const f = await fixture();
    await projectSecurityInventory(f.ctx, f.project.id, []);
    expect(h.resolve).not.toHaveBeenCalled();
    await projectSecurityInventory(f.ctx, f.project.id, advisories);
    expect(h.exec).toHaveBeenCalledTimes(1);
    const now = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 48 * 3_600_000);
    try {
      await projectSecurityInventory(f.ctx, f.project.id, [...advisories].reverse());
      expect(h.exec).toHaveBeenCalledTimes(1);
      await projectSecurityInventory(f.ctx, f.project.id, advisories, true);
      expect(h.exec).toHaveBeenCalledTimes(2);
    } finally {
      now.mockRestore();
    }
    await projectSecurityInventory(
      f.ctx,
      f.project.id,
      advisories.map((a) => ({ ...a, revision: 2 })),
    );
    expect(h.exec).toHaveBeenCalledTimes(3);
  });
  it("never falls back to executing version commands on a shared or bare host", async () => {
    const f = await fixture();
    h.isolated = false;
    const result = await projectSecurityInventory(f.ctx, f.project.id, advisories);
    expect(result.runtimes).toEqual([]);
    expect(result.unknownServices).toEqual([f.service.id]);
    expect(h.exec).not.toHaveBeenCalled();
    expect(h.dispose).toHaveBeenCalledTimes(1);
  });
  it("discards evidence if the active deployment changes during inspection", async () => {
    const f = await fixture();
    h.exec.mockImplementation(async () => {
      await repos.project.update(f.project.id, { activeDeploymentId: null });
      return "OPENSHIP_RUNTIME_node\nv22.23.4\n";
    });
    expect(
      (await projectSecurityInventory(f.ctx, f.project.id, advisories)).deploymentId,
    ).toBeNull();
    expect(await repos.securityAdvisory.project(f.project.id)).toBeUndefined();
    // A sweep may checkpoint this discarded check. Missing evidence must still
    // be eligible next sweep, rather than waiting for the hourly notification pass.
    await repos.securityAdvisory.evaluated(f.project.id, f.owner.orgId, 1);
    await repos.project.update(f.project.id, { activeDeploymentId: f.deployment.id });
    expect((await repos.securityAdvisory.candidates(1)).map((p) => p.id)).toContain(f.project.id);
  });
});
