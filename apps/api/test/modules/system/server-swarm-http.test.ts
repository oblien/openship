import { Hono } from "hono";
import { beforeEach, expect, it, vi } from "vitest";
import { swarmFixture } from "../../../../../packages/contracts/test/swarm-fixture";

const h = vi.hoisted(() => ({ inspect: vi.fn() }));
vi.mock("@repo/platform/engine/lib/platform", () => ({
  getPlatformKernel: () => ({ servers: { inspectSwarm: h.inspect } }),
}));
vi.mock("../../../src/lib/operation-context", () => ({
  operationContext: () => ({ organizationId: "org-a" }),
  operationData: async (_c: unknown, work: Promise<{ data: unknown }>) => (await work).data,
}));
import { inspectSwarm } from "../../../src/modules/system/servers.controller";

const app = new Hono()
  .get("/servers/:id/swarm", inspectSwarm)
  .onError((error, c) => c.json({ message: error.message }, 400));
beforeEach(() => {
  vi.clearAllMocks();
  h.inspect.mockResolvedValue({ data: swarmFixture() });
});

it("converts the query boolean once and rejects invalid values before calling the shared operation", async () => {
  for (const [query, input] of [
    ["", {}],
    ["?details=true", { details: true }],
    ["?details=false", { details: false }],
  ] as const) {
    const response = await app.request(`/servers/manager-a/swarm${query}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(swarmFixture());
    expect(h.inspect).toHaveBeenLastCalledWith({ organizationId: "org-a" }, "manager-a", input);
  }
  for (const details of ["false-ish", "1", "", "null"]) {
    expect((await app.request(`/servers/manager-a/swarm?details=${details}`)).status).toBe(400);
  }
  expect(h.inspect).toHaveBeenCalledTimes(3);
});
