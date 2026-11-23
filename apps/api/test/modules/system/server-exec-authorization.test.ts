import "../jobs/_env";
import { beforeEach, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { and, eq } from "@repo/db";

const host = vi.hoisted(() => ({ execute: vi.fn(), command: vi.fn() }));
vi.mock("@repo/platform/engine/lib/server-execution", async original => ({
  ...await original<typeof import("@repo/platform/engine/lib/server-execution")>(),
  withServerExecution: host.execute,
}));
vi.mock("@repo/platform/engine/lib/agent-exec", () => ({ execOnHost: host.command }));

import { db, schema, seedOwner } from "../jobs/_harness";
import { serverResourceRoutes } from "../../../src/modules/system/server-resource.routes";
import { handleApiError } from "../../../src/middleware/error-handler";

const app = new Hono().onError(handleApiError).route("/api/system", serverResourceRoutes);
beforeEach(() => {
  vi.clearAllMocks();
  host.command.mockResolvedValue({ output: "probe", exitCode: 0, timedOut: false, truncated: false, durationMs: 1 });
  host.execute.mockImplementation(async (_org, _id, work) => work({}));
});

it("rejects an authenticated member before host dispatch and preserves administrator execution", async () => {
  const actor = await seedOwner();
  const id = `server-${actor.userId}`;
  await db.insert(schema.servers).values({ id, organizationId: actor.orgId, name: "Fixture host", sshHost: "203.0.113.10", sshUser: "root" });
  const membership = and(eq(schema.member.userId, actor.userId), eq(schema.member.organizationId, actor.orgId));
  const execute = (serverId = id) => app.request(`/api/system/servers/${serverId}/exec`, {
    method: "POST", headers: { ...actor.auth, "Content-Type": "application/json" }, body: JSON.stringify({ command: "id" }),
  });
  await db.update(schema.member).set({ role: "member" }).where(membership);
  expect((await execute()).status).toBe(404);
  expect(host.execute).not.toHaveBeenCalled();
  expect(host.command).not.toHaveBeenCalled();
  await db.update(schema.member).set({ role: "admin" }).where(membership);
  expect((await execute()).status).toBe(200);
  expect(host.execute).toHaveBeenCalledOnce();
  expect(host.command).toHaveBeenCalledOnce();
  const other = await seedOwner();
  const otherServer = `server-${other.userId}`;
  await db.insert(schema.servers).values({ id: otherServer, organizationId: other.orgId, name: "Other organization", sshHost: "203.0.113.11" });
  expect((await execute(otherServer)).status).toBe(404);
  expect(host.command).toHaveBeenCalledOnce();
  await db.update(schema.member).set({ role: "member" }).where(membership);
  expect((await execute()).status).toBe(404);
  expect(host.command).toHaveBeenCalledOnce();
});
