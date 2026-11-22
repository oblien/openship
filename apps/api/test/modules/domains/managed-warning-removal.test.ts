import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db, eq, repos, schema } from "@repo/db";
import type { ExecutionContext } from "@repo/platform";
import {
  edgeUnsyncedWarning,
  releaseManagedHostnames,
} from "@repo/platform/engine/lib/managed-edge-proxy";
import { removeDomain } from "@repo/platform/engine/modules/domains/domain.service";
import { getProjectPendingActions } from "@repo/platform/engine/modules/projects/pending-actions.service";
import { seedDeployment, seedOrg, seedProject, seedService, setActive } from "../../helpers/seed";

vi.mock("@repo/platform/engine/lib/route-apply.service", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  reconcileProjectRoutes: vi.fn(),
}));
vi.mock("@repo/platform/engine/lib/managed-edge-proxy", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  releaseManagedHostnames: vi.fn(),
}));

describe("removing a domain with an active routing warning", () => {
  const hostname = "failed.opsh.io";
  const managedWarning = (...hosts: string[]) =>
    edgeUnsyncedWarning(
      hosts.map((host) => `${host} (Could not select a Cloud workspace)`),
      "redeploy to retry",
    );
  let ctx: ExecutionContext;
  let project: Awaited<ReturnType<typeof seedProject>>;

  beforeEach(async () => {
    vi.mocked(releaseManagedHostnames).mockReset().mockResolvedValue({ failures: [] });
    ctx = (await seedOrg()) as ExecutionContext;
    project = await seedProject(ctx.organizationId);
  });

  afterEach(async () => {
    if (ctx) {
      await db.delete(schema.organization).where(eq(schema.organization.id, ctx.organizationId));
    }
  });

  const addDomain = (host: string, serviceId?: string) =>
    repos.domain.create({
      projectId: project.id,
      serviceId,
      hostname: host,
      domainType: host.endsWith(".opsh.io") ? "free" : "custom",
      verificationToken: "test",
    });
  const activate = async (warning = managedWarning(hostname)) => {
    const dep = await seedDeployment(project, {
      meta: { edgeUnsynced: true, deployWarning: warning, deployTarget: "server" },
    });
    await setActive(project.id, dep.id);
    return dep;
  };
  const pendingRouting = async () =>
    (await getProjectPendingActions(project.id, ctx.organizationId)).some(
      ({ kind }) => kind === "routing_unsynced",
    );

  it.each([false, true])(
    "clears the stale warning after a successful removal (service: %s)",
    async (serviceOwned) => {
      const service = serviceOwned ? await seedService(project.id, { name: "web" }) : null;
      const failed = await addDomain(hostname, service?.id);
      const custom = await addDomain("example.com");
      const dep = await activate();
      expect(await pendingRouting()).toBe(true);

      await removeDomain(ctx, failed.id);

      expect(await repos.domain.findById(failed.id)).toBeUndefined();
      expect(await repos.domain.findById(custom.id)).toBeDefined();
      expect(await repos.deployment.findById(dep.id)).toMatchObject({
        status: "ready",
        meta: { deployTarget: "server" },
      });
      expect((await repos.deployment.findById(dep.id))?.meta).not.toHaveProperty("deployWarning");
      expect(await pendingRouting()).toBe(false);
    },
  );

  it.each([
    managedWarning("other-failed.opsh.io"),
    `Could not verify HTTPS for ${hostname} or example.com`,
    `${managedWarning(hostname)} · Static output is missing`,
  ])(
    "preserves a warning that cannot be attributed to the deleted route alone",
    async (warning) => {
      const failed = await addDomain(hostname);
      const dep = await activate(warning);
      await removeDomain(ctx, failed.id);
      expect((await repos.deployment.findById(dep.id))?.meta).toMatchObject({
        edgeUnsynced: true,
        deployWarning: warning,
      });
      expect(await pendingRouting()).toBe(true);
    },
  );

  it("keeps the warning when a managed route remains or release fails", async () => {
    const failed = await addDomain(hostname);
    const remaining = await addDomain("remaining.opsh.io");
    const dep = await activate();
    vi.mocked(releaseManagedHostnames).mockResolvedValueOnce({
      failures: ["upstream unavailable"],
    });
    await expect(removeDomain(ctx, failed.id)).rejects.toMatchObject({
      code: "MANAGED_EDGE_RELEASE_FAILED",
    });
    expect(await repos.domain.findById(failed.id)).toBeDefined();
    expect(await pendingRouting()).toBe(true);

    await removeDomain(ctx, failed.id);
    expect(await repos.domain.findById(remaining.id)).toBeDefined();
    expect((await repos.deployment.findById(dep.id))?.meta).toHaveProperty("deployWarning");
  });

  it("clears a shared warning when the last removed route was listed second", async () => {
    const first = await addDomain(hostname);
    const second = await addDomain("second.opsh.io");
    await activate(managedWarning(first.hostname, second.hostname));

    await removeDomain(ctx, first.id);
    expect(await pendingRouting()).toBe(true);

    await removeDomain(ctx, second.id);
    expect(await pendingRouting()).toBe(false);
  });

  it("preserves changes to deployment status and unrelated metadata during deletion", async () => {
    const failed = await addDomain(hostname);
    const dep = await activate();
    vi.mocked(releaseManagedHostnames).mockImplementationOnce(async () => {
      await repos.deployment.updateStatus(dep.id, "verifying", {
        meta: {
          ...(dep.meta as Record<string, unknown>),
          readinessWarning: "Still checking the application",
        },
      });
      return { failures: [] };
    });

    await removeDomain(ctx, failed.id);

    const current = await repos.deployment.findById(dep.id);
    expect(current?.status).toBe("verifying");
    expect(current?.meta).toEqual({
      deployTarget: "server",
      readinessWarning: "Still checking the application",
    });
  });

  it("does not clear a newer routing warning", async () => {
    const failed = await addDomain(hostname);
    const dep = await activate();
    const warning = "HTTPS is pending for example.com";
    vi.mocked(releaseManagedHostnames).mockImplementationOnce(async () => {
      await repos.deployment.updateStatus(dep.id, "ready", {
        meta: { ...(dep.meta as Record<string, unknown>), deployWarning: warning },
      });
      return { failures: [] };
    });
    await removeDomain(ctx, failed.id);
    expect((await repos.deployment.findById(dep.id))?.meta).toMatchObject({
      edgeUnsynced: true,
      deployWarning: warning,
    });
  });
});
