import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { db, eq, repos, schema } from "@repo/db";
import { seedOwner, seedServer } from "../../../../test/modules/jobs/_harness";
import { systemRoutes } from "../system.routes";
import { handleApiError } from "../../../middleware/error-handler";

const io = vi.hoisted(() => ({ ssh: vi.fn(async () => "ok") }));
vi.mock("@repo/platform/engine/lib/ssh-manager", () => ({
  sshManager: { withExecutor: (...args: unknown[]) => io.ssh(...(args as [])) },
}));
vi.mock("node:dns/promises", () => ({ resolve4: async () => ["10.0.0.1"] }));
vi.mock("./openship-dist", async (original) => ({
  ...(await original<typeof import("./openship-dist")>()),
  resolveOpenshipDistDirOrNull: () => "/test/release",
}));
const app = new Hono().onError(handleApiError).route("/api/system", systemRoutes);
const domain = { kind: "custom", hostname: "migration.test.invalid" };
beforeEach(() => io.ssh.mockClear());

async function request(
  path: string,
  owner: Awaited<ReturnType<typeof seedOwner>>,
  serverId: string,
) {
  return app.request(`http://openship.test/api/system/migration/${path}`, {
    method: "POST",
    headers: {
      ...owner.auth,
      "Content-Type": "application/json",
      "X-Organization-Id": owner.orgId,
    },
    body: JSON.stringify({ serverId, domain }),
  });
}

describe("whole-instance remote migration guard (#869)", () => {
  it("reports the unavailable deployment step even when all infrastructure checks pass", async () => {
    const owner = await seedOwner({ instanceAdmin: true });
    const serverId = await seedServer(owner.orgId);
    const response = await request("preflight", owner, serverId);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ready: false,
      checks: {
        ssh: { ok: true },
        releaseDist: { ok: true },
        domain: { ok: true },
        deployment: { ok: false, detail: expect.stringContaining("Data transfer") },
      },
    });
  });

  it("returns a clear 501 without creating rows, exporting or running remote commands", async () => {
    const owner = await seedOwner({ instanceAdmin: true });
    const serverId = await seedServer(owner.orgId);
    const before = await repos.instanceSettings.get();
    const response = await request("start", owner, serverId);
    expect(response.status).toBe(501);
    expect(await response.json()).toMatchObject({
      code: "SERVER_MIGRATION_UNAVAILABLE",
      error: expect.stringContaining("Data transfer"),
    });
    expect(io.ssh).not.toHaveBeenCalled();
    expect(await repos.instanceSettings.get()).toEqual(before);
    expect(
      await db.select().from(schema.project).where(eq(schema.project.organizationId, owner.orgId)),
    ).toEqual([]);
    expect(
      await db
        .select()
        .from(schema.projectGroup)
        .where(eq(schema.projectGroup.organizationId, owner.orgId)),
    ).toEqual([]);
  });

  it("retains the instance-admin boundary for an ordinary organization owner", async () => {
    const owner = await seedOwner();
    const serverId = await seedServer(owner.orgId);
    for (const path of ["preflight", "start"])
      expect((await request(path, owner, serverId)).status).toBe(403);
    expect(io.ssh).not.toHaveBeenCalled();
  });
});
