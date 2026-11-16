import { beforeEach, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { repos, seedOwner, seedServer } from "../jobs/_harness";
import { mintPatToken } from "@repo/platform/engine/lib/pat";
import { OpenshipClient } from "@repo/sdk/client";
import { connectedServerRoutes } from "../../../src/modules/system/connected-server.routes";
import { healthRoutes } from "../../../src/modules/health/health.routes";
import { handleApiError } from "../../../src/middleware/error-handler";
const edge = vi.hoisted(() => ({ getEdgePages: vi.fn(), setEdgePages: vi.fn() }));
vi.mock("@repo/platform/engine/lib/openresty-paths", () => ({
  withOpenRestyRouting: async (_id: string, work: (routing: typeof edge) => unknown) => work(edge),
}));
const app = new Hono()
  .onError(handleApiError)
  .route("/api/health", healthRoutes)
  .route("/api/system", connectedServerRoutes);
const client = (token: string, organizationId: string) =>
  new OpenshipClient({
    baseUrl: "http://openship.test",
    token,
    organizationId,
    fetch: ((url, init) => app.request(url as string, init)) as typeof fetch,
  }).servers;
const config = {
  files: [{ id: "default", name: "default.html", html: "<h1>Choose a domain</h1>" }],
  errors: [],
  defaultPageId: "default",
};
beforeEach(() => {
  vi.resetAllMocks();
  edge.getEdgePages.mockResolvedValue(config);
  edge.setEdgePages.mockResolvedValue(undefined);
});
it("shares server pages through the SDK and enforces ownership and read-only credentials before execution", async () => {
  const owner = await seedOwner();
  const serverId = await seedServer(owner.orgId);
  const remote = client(owner.token, owner.orgId);
  expect(await remote.getEdgePages(serverId)).toEqual({ config });
  expect(await remote.updateEdgePages(serverId, config)).toEqual({ config });
  expect(edge.setEdgePages).toHaveBeenCalledExactlyOnceWith(config);
  edge.getEdgePages.mockClear();
  edge.setEdgePages.mockClear();
  const other = await seedOwner();
  await expect(client(other.token, other.orgId).getEdgePages(serverId)).rejects.toMatchObject({
    statusCode: 404,
  });
  await expect(
    client(other.token, other.orgId).updateEdgePages(serverId, config),
  ).rejects.toMatchObject({ statusCode: 404 });
  const pat = mintPatToken();
  await repos.personalAccessToken.create({
    userId: owner.userId,
    organizationId: owner.orgId,
    name: "read only",
    tokenPrefix: pat.tokenPrefix,
    tokenHash: pat.tokenHash,
    readOnly: true,
    scoped: false,
    expiresAt: null,
  });
  await expect(
    client(pat.token, owner.orgId).updateEdgePages(serverId, config),
  ).rejects.toMatchObject({ statusCode: 403 });
  expect(edge.getEdgePages).not.toHaveBeenCalled();
  expect(edge.setEdgePages).not.toHaveBeenCalled();
});
it("rejects provider-owned server pages before reaching the edge", async () => {
  const owner = await seedOwner();
  const workspace = await repos.cloudWorkspace.create({
    organizationId: owner.orgId,
    name: "Managed",
  });
  const serverId = (await repos.server.findByWorkspace(workspace.id, owner.orgId))!.id;
  const remote = client(owner.token, owner.orgId);
  await expect(remote.getEdgePages(serverId)).rejects.toMatchObject({ statusCode: 409 });
  await expect(remote.updateEdgePages(serverId, config)).rejects.toMatchObject({ statusCode: 409 });
  expect(edge.getEdgePages).not.toHaveBeenCalled();
  expect(edge.setEdgePages).not.toHaveBeenCalled();
});
