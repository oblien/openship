import { beforeEach, describe, expect, it, vi } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { ServerDetailSchema, type ManagedServerConnection } from "@repo/contracts";

const h = vi.hoisted(() => ({
  identity: { apiUrl: "https://cloud.example.test", userId: "cloud-user", organizationId: "cloud-org", token: "session" },
  fetch: vi.fn(), link: vi.fn(), workspace: vi.fn(), reserve: vi.fn(), attach: vi.fn(),
  setNamespace: vi.fn(), finishDeletion: vi.fn(), binding: null as null | { workspaceId: string },
}));
vi.mock("@repo/platform/engine/config/env", () => ({ env: { CLOUD_MODE: false } }));
vi.mock("@repo/platform/engine/lib/cloud/transport", async original => ({
  ...await original<typeof import("@repo/platform/engine/lib/cloud/transport")>(),
  resolveOrgCloudUserId: async () => "local-owner",
  readCloudSession: async () => ({ ...h.identity }),
  cloudFetchAsOrgOwner: h.fetch,
}));
vi.mock("@repo/platform/engine/lib/provision-lock", () => ({ createProvisionLock: () => ({ run: (work: () => Promise<unknown>) => work() }) }));
vi.mock("@repo/db", () => ({ repos: {
  cloudWorkspace: { findByIdInOrganization: h.workspace, link: h.link, setNamespace: h.setNamespace,
    finishDeletion: h.finishDeletion, listByOrganization: async () => [] },
  server: { findByWorkspace: async () => ({ id: "local-server", workspaceId: "local-workspace" }) },
  cloudDockerWorkspace: { reserve: h.reserve, attach: h.attach, updateResources: vi.fn(), markReady: vi.fn() },
} }));
import { connectCloudServer, requireLinkedCloudServer, confirmLinkedServerDeletion } from "@repo/platform/engine/lib/cloud/server-link";
import { remoteServerConnection } from "@repo/platform/engine/lib/cloud/server-connection";

const remote = { apiUrl: "https://cloud.example.test", userId: "cloud-user", organizationId: "cloud-org", serverId: "cloud-server", workspaceId: "cloud-workspace" };
const summary = { id: remote.workspaceId, serverId: remote.serverId, name: "Managed", planTierId: "starter", subscriptionStatus: "active",
  projectCount: 0, state: "running", resources: { cpuCores: 2, memoryMb: 4096, diskMb: 25600 }, operation: null, createdAt: "2026-10-01T00:00:00Z" };
const server = { ...Value.Create(ServerDetailSchema), id: remote.serverId, managed: summary };
const row = { id: "local-workspace", organizationId: "local-org", remote, name: "Managed", createdAt: new Date(), operation: null };
const authorized = { ...remote, apiUrl: undefined };
const connection = (): ManagedServerConnection => ({
  userId: remote.userId, organizationId: remote.organizationId, serverId: remote.serverId,
  ownerWorkspaceId: remote.workspaceId, workspaceId: "provider-vm", namespace: "namespace", image: "oblien/docker:29",
  resources: summary.resources, providerApiUrl: "https://provider.example.test", state: "running", token: "namespace-token",
  expiresAt: new Date(Date.now() + 1800000).toISOString(),
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  vi.resetAllMocks(); Object.assign(h.identity, { ...remote, token: "session" });
  h.workspace.mockResolvedValue(row);
  h.link.mockResolvedValue(row);
  h.binding = null;
  h.reserve.mockImplementation(async () => h.binding ?? {});
  h.fetch.mockImplementation(async (_org: string, path: string) => json(path.endsWith("/authorize") ? authorized : server));
});

describe("verified managed server links", () => {
  it("requires Cloud execution permission before saving the selected server", async () => {
    const result = await connectCloudServer("local-org", remote.serverId);
    expect(result).toMatchObject({ id: row.id, serverId: "local-server" });
    expect(h.fetch.mock.calls[1]![1]).toBe(`/api/cloud/servers/${remote.serverId}/authorize`);
    expect(h.link).toHaveBeenCalledExactlyOnceWith({ organizationId: "local-org", name: "Managed", remote });
  });

  it("does not turn server read access into permission to execute on that server", async () => {
    h.fetch.mockResolvedValueOnce(json(server)).mockResolvedValueOnce(json({ error: "Forbidden" }, 403));
    await expect(connectCloudServer("local-org", remote.serverId)).rejects.toMatchObject({ statusCode: 403 });
    expect(h.link).not.toHaveBeenCalled();
  });

  it("rejects a mismatched managed server inside an otherwise matching response", async () => {
    h.fetch.mockResolvedValueOnce(json({ ...server, managed: { ...summary, serverId: "other-server" } }));
    await expect(connectCloudServer("local-org", remote.serverId)).rejects.toMatchObject({ code: "CLOUD_SERVER_NOT_FOUND" });
    expect(h.link).not.toHaveBeenCalled();
  });

  it.each(["userId", "organizationId", "serverId", "workspaceId"])("rejects an authorization response for another %s", async field => {
    h.fetch.mockResolvedValueOnce(json(server)).mockResolvedValueOnce(json({ ...authorized, [field]: "other" }));
    await expect(connectCloudServer("local-org", remote.serverId)).rejects.toMatchObject({ code: "SERVER_NOT_FOUND" });
    expect(h.link).not.toHaveBeenCalled();
  });

  it("does not attach a late server response after the Cloud connection changes", async () => {
    h.fetch.mockResolvedValueOnce(json(server)).mockImplementationOnce(async () => {
      h.identity.userId = "another-user";
      return json(authorized);
    });
    await expect(connectCloudServer("local-org", remote.serverId)).rejects.toMatchObject({ code: "CLOUD_SERVER_CONNECTION_CHANGED" });
    expect(h.link).not.toHaveBeenCalled();
  });

  it("refuses to use an existing link under a different Cloud organization", async () => {
    h.identity.organizationId = "another-org";
    await expect(requireLinkedCloudServer("local-org", row.id)).rejects.toMatchObject({ code: "CLOUD_SERVER_CONNECTION_CHANGED" });
    expect(h.fetch).not.toHaveBeenCalled();
  });
});

describe("server credential handoff", () => {
  it.each(["userId", "organizationId", "serverId", "ownerWorkspaceId"])("rejects a different %s before updating the local binding", async field => {
    h.fetch.mockResolvedValueOnce(json({ ...connection(), [field]: "other" }));
    await expect(remoteServerConnection("local-org", row.id)).rejects.toMatchObject({ code: "CLOUD_SERVER_IDENTITY_MISMATCH" });
    expect(h.reserve).not.toHaveBeenCalled();
  });

  it("will not substitute a new provider VM for the server containing the project's data", async () => {
    h.binding = { workspaceId: "original-vm" };
    h.fetch.mockResolvedValueOnce(json(connection()));
    await expect(remoteServerConnection("local-org", row.id)).rejects.toMatchObject({ code: "CLOUD_SERVER_IDENTITY_MISMATCH" });
    expect(h.attach).not.toHaveBeenCalled();
  });

  it("accepts an unexpired connection for the exact selected server", async () => {
    h.binding = { workspaceId: "provider-vm" };
    const value = connection();
    h.fetch.mockResolvedValueOnce(json(value));
    expect(await remoteServerConnection("local-org", row.id)).toEqual(value);
    expect(h.attach).toHaveBeenCalledExactlyOnceWith({ ownerWorkspaceId: row.id }, "local-org", "namespace", "provider-vm");
  });

  it("rejects expired connection credentials", async () => {
    h.fetch.mockResolvedValueOnce(json({ ...connection(), expiresAt: "2000-01-01T00:00:00Z" }));
    await expect(remoteServerConnection("local-org", row.id)).rejects.toMatchObject({ code: "CLOUD_SERVER_IDENTITY_MISMATCH" });
    expect(h.reserve).not.toHaveBeenCalled();
  });
});

describe("linked server deletion", () => {
  const deleting = { ...row, deletionInProgress: new Date(), operation: { id: "delete-one", kind: "delete" } };
  it("does not treat a permission-filtered 404 as proof of deletion", async () => {
    h.fetch.mockResolvedValueOnce(json({ error: "Not found" }, 404));
    expect(await confirmLinkedServerDeletion(deleting as never)).toBe(false);
    expect(h.finishDeletion).not.toHaveBeenCalled();
  });
  it("requires a receipt for the exact deletion operation", async () => {
    h.fetch.mockResolvedValueOnce(json({ serverId: remote.serverId, workspaceId: remote.workspaceId, operationId: "other-delete", deletedAt: new Date().toISOString() }));
    await expect(confirmLinkedServerDeletion(deleting as never)).rejects.toMatchObject({ code: "CLOUD_SERVER_IDENTITY_MISMATCH" });
    expect(h.finishDeletion).not.toHaveBeenCalled();
  });
});
