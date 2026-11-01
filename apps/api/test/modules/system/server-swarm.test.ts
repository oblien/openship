import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ExecutionContext } from "@repo/platform";
import { AppError } from "@repo/core";
import { swarmFixture } from "../../../../../packages/contracts/test/swarm-fixture";

const h = vi.hoisted(() => ({
  env: { CLOUD_MODE: false },
  server: vi.fn(),
  runtime: vi.fn(),
  inspect: vi.fn(),
  dispose: vi.fn(),
}));
vi.mock("@repo/platform/engine/config", () => ({ env: h.env }));
vi.mock("@repo/platform/engine/config/env", () => ({ env: h.env }));
vi.mock("@repo/db", () => ({ repos: { server: { getInOrganization: h.server } } }));
vi.mock("@repo/platform/engine/lib/box-org", () => ({ isLocalHostRow: async () => false }));
vi.mock("@repo/platform/engine/lib/deployment-runtime", () => ({
  createServerDockerRuntime: h.runtime,
}));
vi.mock("@repo/adapters", () => ({ inspectDockerSwarm: h.inspect }));
import { serverSwarmResources } from "@repo/platform/engine/modules/system/server-swarm.operations";

const ctx = { organizationId: "org-a" } as ExecutionContext;
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("OPENSHIP_NATIVE", "false");
  h.env.CLOUD_MODE = false;
  h.server.mockResolvedValue({
    id: "server-a",
    organizationId: "org-a",
    sshHost: "server.example.test",
  });
  h.runtime.mockResolvedValue({ docker: { connection: "saved" }, dispose: h.dispose });
  h.inspect.mockResolvedValue(swarmFixture());
});
afterEach(() => vi.unstubAllEnvs());

it("uses the selected server transport and releases it after inspection and errors", async () => {
  expect(await serverSwarmResources.inspectSwarm(ctx, "server-a", { details: true })).toEqual(
    swarmFixture(),
  );
  expect(h.server).toHaveBeenCalledWith("server-a", "org-a");
  expect(h.runtime).toHaveBeenCalledWith("server-a", "org-a");
  expect(h.inspect).toHaveBeenCalledWith({ connection: "saved" }, true);
  expect(h.dispose).toHaveBeenCalledTimes(1);
  h.inspect.mockRejectedValueOnce(new Error("private Docker diagnostic"));
  await expect(serverSwarmResources.inspectSwarm(ctx, "server-a")).rejects.toMatchObject({
    code: "SWARM_INSPECTION_UNAVAILABLE",
  });
  h.inspect.mockRejectedValueOnce(new AppError("Timed out", 504, "SWARM_INSPECTION_TIMEOUT"));
  await expect(serverSwarmResources.inspectSwarm(ctx, "server-a")).rejects.toMatchObject({
    code: "SWARM_INSPECTION_TIMEOUT",
  });
  expect(h.dispose).toHaveBeenCalledTimes(3);
});

it("refuses Cloud, foreign servers, managed destinations and import-only connections before opening Docker", async () => {
  h.env.CLOUD_MODE = true;
  await expect(serverSwarmResources.inspectSwarm(ctx, "server-a")).rejects.toMatchObject({
    code: "CAPABILITY_UNAVAILABLE",
  });
  expect(h.server).not.toHaveBeenCalled();
  h.env.CLOUD_MODE = false;
  for (const [server, code] of [
    [null, "NOT_FOUND"],
    [{ workspaceId: "workspace-a" }, "MANAGED_SERVER_LIFECYCLE_REQUIRED"],
    [{ purpose: "migration_source" }, "MIGRATION_SOURCE_ONLY"],
    [{ sshHost: null }, "SERVER_CONNECTION_MISSING"],
  ] as const) {
    h.server.mockResolvedValueOnce(server);
    await expect(serverSwarmResources.inspectSwarm(ctx, "server-a")).rejects.toMatchObject({
      code,
    });
  }
  expect(h.runtime).not.toHaveBeenCalled();
});
