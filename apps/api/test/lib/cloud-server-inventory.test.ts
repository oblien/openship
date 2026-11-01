import { beforeEach, describe, expect, it, vi } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { ServerDetailSchema, type ServerDetail } from "@repo/contracts";
import type { ExecutionContext } from "@repo/platform";

const h = vi.hoisted(() => ({ request: vi.fn(), identity: vi.fn(), links: vi.fn(), owner: vi.fn(), env: { CLOUD_MODE: false } }));
vi.mock("@repo/db", () => ({ repos: { cloudWorkspace: { listByOrganization: h.links } } }));
vi.mock("@repo/platform/engine/config/index", () => ({ env: h.env }));
vi.mock("@repo/platform/engine/lib/cloud/server-link", () => ({ linkedCloudIdentity: h.identity, remoteCloudRequest: h.request }));
vi.mock("@repo/platform/engine/lib/cloud/transport", () => ({
  resolveOrgCloudUserId: h.owner,
  sameCloudIdentity: (a: Record<string, string>, b: Record<string, string>) =>
    ["apiUrl", "userId", "organizationId"].every(key => a[key] === b[key]),
}));
import { mergeCloudServerInventory, readCloudServerInventory } from "@repo/platform/engine/lib/cloud/server-inventory";

const identity = { apiUrl: "https://cloud.example.test", userId: "cloud-user", organizationId: "cloud-org" };
const ctx = { userId: "local-user", organizationId: "local-org", role: "owner", scopeMode: "resource" } as ExecutionContext;
const local = { ...Value.Create(ServerDetailSchema), id: "local-server", source: "local", name: "Own VPS" } as ServerDetail;
const cloud: ServerDetail = { ...local, id: "cloud-server", name: "Production", managed: {
  id: "cloud-workspace", serverId: "cloud-server", name: "Production", state: "running", projectCount: 2,
  planTierId: "pro", subscriptionStatus: "active", resources: { cpuCores: 4, memoryMb: 16384, diskMb: 131072 },
  operation: null, createdAt: "2026-10-01T00:00:00.000Z",
} };

beforeEach(() => {
  vi.resetAllMocks(); h.env.CLOUD_MODE = false;
  h.owner.mockResolvedValue(ctx.userId); h.identity.mockResolvedValue(identity);
  h.links.mockResolvedValue([]); h.request.mockResolvedValue({ servers: [cloud] });
});

describe("Cloud inventory reconciliation", () => {
  it("combines existing servers without writing or accumulating duplicate rows", async () => {
    const rows = [structuredClone(local)];
    const expected = [local, { ...cloud, source: "cloud" }];
    expect(await mergeCloudServerInventory(ctx, rows)).toEqual(expected);
    expect(await mergeCloudServerInventory(ctx, rows)).toEqual(expected);
    expect(rows).toEqual([local]);
    expect(h.request).toHaveBeenCalledWith(ctx.organizationId, "/api/system/servers/destinations", undefined, identity);
  });

  it("keeps an explicit execution link and exposes its canonical IDs only once", async () => {
    const linked = { ...cloud, id: "linked-server", managed: { ...cloud.managed!, id: "linked-workspace", serverId: "linked-server" } };
    h.links.mockResolvedValue([{ id: "linked-workspace", remote: { ...identity, serverId: cloud.id, workspaceId: cloud.managed!.id } }]);
    const result = await mergeCloudServerInventory(ctx, [local, linked]);
    expect(result).toEqual([local, { ...linked, cloudReference: { serverId: cloud.id, workspaceId: cloud.managed!.id } }]);
  });

  it("does not match another account's link merely because its server ID matches", async () => {
    h.links.mockResolvedValue([{ id: "old-workspace", remote: { ...identity, userId: "other-user", serverId: cloud.id } }]);
    const old = { ...local, id: "old-server", managed: { ...cloud.managed!, id: "old-workspace" } };
    expect(await mergeCloudServerInventory(ctx, [local, old])).toEqual([local, old, { ...cloud, source: "cloud" }]);
  });

  it.each([
    { scopeMode: "fixed" }, { tokenScope: { tokenId: "scoped" } }, { role: "restricted" },
    { credential: { organizationId: "local-org", readOnly: false } },
  ])("never grants a scoped credential the owner's Cloud inventory: %j", async restriction => {
    expect(await mergeCloudServerInventory({ ...ctx, ...restriction } as ExecutionContext, [local])).toEqual([local]);
    expect(h.request).not.toHaveBeenCalled();
  });

  it("keeps Cloud canonical and keeps disconnected installations local", async () => {
    h.env.CLOUD_MODE = true;
    expect(await mergeCloudServerInventory(ctx, [local])).toEqual([local]);
    h.env.CLOUD_MODE = false; h.owner.mockResolvedValue(null);
    expect(await mergeCloudServerInventory(ctx, [local])).toEqual([local]);
    expect(h.request).not.toHaveBeenCalled();
  });

  it("preserves local hosts when Cloud is temporarily unavailable", async () => {
    h.request.mockRejectedValue(new Error("Cloud unavailable"));
    expect(await mergeCloudServerInventory(ctx, [local])).toEqual([local]);
  });

  it("discards inventory fetched for a previous Cloud identity", async () => {
    h.identity.mockResolvedValueOnce(identity).mockResolvedValue({ ...identity, organizationId: "another-org" });
    await expect(readCloudServerInventory(ctx.organizationId)).rejects.toMatchObject({ code: "CLOUD_SERVER_CONNECTION_CHANGED" });
  });

  it.each([
    { servers: [cloud, cloud] },
    { servers: [cloud, { ...cloud, id: "another-server", managed: { ...cloud.managed!, serverId: "another-server" } }] },
    { servers: [{ ...cloud, managed: { ...cloud.managed, serverId: "different-server" } }] },
    { servers: [{ id: "partial-server" }] },
  ])("rejects malformed or ambiguous identities", async ({ servers }) => {
    h.request.mockResolvedValue({ servers });
    await expect(readCloudServerInventory(ctx.organizationId)).rejects.toMatchObject({ code: "INVALID_CLOUD_RESPONSE" });
  });
});
