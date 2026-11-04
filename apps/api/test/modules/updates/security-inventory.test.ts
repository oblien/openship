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
  it("expires healthy evidence and refreshes on rule changes and explicit checks", async () => {
    const f = await fixture();
    await projectSecurityInventory(f.ctx, f.project.id, []);
    expect(h.resolve).not.toHaveBeenCalled();
    await projectSecurityInventory(f.ctx, f.project.id, advisories);
    expect(h.exec).toHaveBeenCalledTimes(1);
    const now = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 48 * 3_600_000);
    try {
      await projectSecurityInventory(f.ctx, f.project.id, [...advisories].reverse());
      expect(h.exec).toHaveBeenCalledTimes(2);
      now.mockReturnValue(Date.now() + 1);
      await projectSecurityInventory(f.ctx, f.project.id, advisories, true);
      expect(h.exec).toHaveBeenCalledTimes(3);
    } finally {
      now.mockRestore();
    }
    await projectSecurityInventory(
      f.ctx,
      f.project.id,
      advisories.map((a) => ({ ...a, revision: 2 })),
    );
    expect(h.exec).toHaveBeenCalledTimes(4);
  });
  it("retries temporary failures after backoff, without probing on every read", async () => {
    const f = await fixture();
    h.exec.mockRejectedValueOnce(new Error("temporarily unavailable"));
    const first = await projectSecurityInventory(f.ctx, f.project.id, advisories);
    expect(first.unknownServices).toEqual([f.service.id]);
    await projectSecurityInventory(f.ctx, f.project.id, advisories);
    expect(h.exec).toHaveBeenCalledTimes(1);
    const row = await repos.securityAdvisory.project(f.project.id);
    expect(row?.probeFailures).toBe(1);
    const now = vi.spyOn(Date, "now").mockReturnValue(row!.nextInspectionAt!.getTime() + 1);
    try {
      expect(
        (await projectSecurityInventory(f.ctx, f.project.id, advisories)).unknownServices,
      ).toEqual([]);
      expect(h.exec).toHaveBeenCalledTimes(2);
      expect((await repos.securityAdvisory.project(f.project.id))?.probeFailures).toBe(0);
    } finally {
      now.mockRestore();
    }
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
  it("preserves previously observed runtime warnings during temporary probe failures", async () => {
    const f = await fixture();
    const initial = await projectSecurityInventory(f.ctx, f.project.id, advisories);
    h.exec.mockRejectedValue(new Error("offline"));
    const now = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_000);
    try {
      const result = await projectSecurityInventory(f.ctx, f.project.id, advisories, true);
      expect(result.runtimes).toEqual(initial.runtimes);
      expect(result.checkedAt).toBe(initial.checkedAt);
      expect(result.unknownServices).toEqual([f.service.id]);
    } finally {
      now.mockRestore();
    }
  });
  it("retains a missing runtime's evidence during a partial probe without retaining superseded versions", async () => {
    const f = await fixture();
    const rules: SecurityAdvisory[] = [
      {
        id: "partial-probe",
        revision: 1,
        title: "Fixture",
        message: "Fixture",
        severity: "high",
        publishedAt: "2026-01-01T00:00:00Z",
        url: "https://example.test/security",
        action: "manual",
        targets: [
          { kind: "runtime", runtime: "node", affected: "<22.23.4", fixed: ">=22.23.4" },
          { kind: "runtime", runtime: "python", affected: "<3.12.9", fixed: ">=3.12.9" },
        ],
      },
    ];
    h.exec.mockResolvedValue(
      "OPENSHIP_RUNTIME_node\nv22.23.3\nOPENSHIP_RUNTIME_python\nPython 3.12.8\n",
    );
    const before = await projectSecurityInventory(f.ctx, f.project.id, rules);
    const now = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_000);
    try {
      h.exec.mockResolvedValue(
        "OPENSHIP_RUNTIME_node\nerror loading shared libraries\nOPENSHIP_RUNTIME_python\nPython 3.12.9\n",
      );
      const result = await projectSecurityInventory(f.ctx, f.project.id, rules, true);
      expect(result.runtimes).toEqual(
        expect.arrayContaining([
          { serviceId: f.service.id, runtime: "node", version: "22.23.3" },
          { serviceId: f.service.id, runtime: "python", version: "3.12.9" },
        ]),
      );
      expect(result.runtimes).toHaveLength(2);
      expect(result.unknownServices).toEqual([f.service.id]);
      expect(result.checkedAt).toBe(before.checkedAt);
      expect((await repos.securityAdvisory.project(f.project.id))?.probeFailures).toBe(1);
    } finally {
      now.mockRestore();
    }
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
