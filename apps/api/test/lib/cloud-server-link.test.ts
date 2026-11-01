import { beforeEach, describe, expect, it, vi } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { ServerDetailSchema, type ManagedServerConnection } from "@repo/contracts";

const h = vi.hoisted(() => ({
  identity: { apiUrl: "https://cloud.example.test", userId: "cloud-user", organizationId: "cloud-org", token: "session" },
  fetch: vi.fn(), link: vi.fn(), workspace: vi.fn(), workspaceById: vi.fn(), workspaces: vi.fn(),
  reserve: vi.fn(), attach: vi.fn(), proxy: vi.fn(), audit: vi.fn(),
  setNamespace: vi.fn(), finishDeletion: vi.fn(), projects: vi.fn(), connected: true, binding: null as null | { workspaceId: string },
}));
vi.mock("@repo/platform/engine/config/env", () => ({ env: { CLOUD_MODE: false } }));
vi.mock("@repo/platform/engine/modules/billing/billing-application.service", () => ({ listPlans: vi.fn() }));
vi.mock("@repo/platform/engine/modules/billing/billing-local.service", () => ({ proxyToCloudBilling: h.proxy }));
vi.mock("@repo/platform/engine/lib/authorization", () => ({ authorization: { authorize: vi.fn() } }));
vi.mock("@repo/platform/engine/lib/audit-emitter", () => ({ audit: { recordAsync: h.audit }, operationAuditContext: (ctx: unknown) => ctx }));
vi.mock("@repo/platform/engine/lib/cloud/transport", async original => ({
  ...await original<typeof import("@repo/platform/engine/lib/cloud/transport")>(),
  resolveOrgCloudUserId: async () => "local-owner",
  readCloudSession: async () => h.connected ? { ...h.identity } : null,
  cloudFetchAsOrgOwner: h.fetch,
}));
vi.mock("@repo/platform/engine/lib/provision-lock", () => ({ createProvisionLock: () => ({ run: (work: () => Promise<unknown>) => work() }) }));
vi.mock("@repo/db", () => ({ repos: {
  cloudWorkspace: { findById: h.workspaceById, findByIdInOrganization: h.workspace, link: h.link, setNamespace: h.setNamespace,
    finishDeletion: h.finishDeletion, listByOrganization: h.workspaces },
  server: { findByWorkspace: async () => ({ id: "local-server", workspaceId: "local-workspace" }) },
  project: { listByWorkspace: h.projects },
  cloudDockerWorkspace: { reserve: h.reserve, attach: h.attach, updateResources: vi.fn(), markReady: vi.fn() },
} }));
import { connectCloudServer, requireLinkedCloudServer, confirmLinkedServerDeletion, linkedServerSummary, linkedServerRequest } from "@repo/platform/engine/lib/cloud/server-link";
import { remoteServerConnection } from "@repo/platform/engine/lib/cloud/server-connection";
import { billingDependencies } from "@repo/platform/engine/modules/billing/billing.operations";

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
  h.connected = true;
  h.projects.mockResolvedValue([]);
  h.workspace.mockImplementation(async (id, org) => id === row.id && org === row.organizationId ? row : undefined);
  h.workspaceById.mockImplementation(async id => id === row.id ? row : undefined);
  h.workspaces.mockResolvedValue([]);
  h.link.mockResolvedValue(row);
  h.binding = null;
  h.reserve.mockImplementation(async () => h.binding ?? {});
  h.fetch.mockImplementation(async (_org: string, path: string) => json(path.endsWith("/authorize") ? authorized : server));
});

describe("linked server connection feedback", () => {
  it("retains the explicit link and classifies missing sign-in without contacting Cloud", async () => {
    h.connected = false;
    expect(await linkedServerSummary(row as never)).toMatchObject({
      id: row.id, serverId: "local-server", subscriptionStatus: "unavailable", resources: null,
      connectionIssue: "not_connected",
    });
    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.finishDeletion).not.toHaveBeenCalled();
    expect(h.link).not.toHaveBeenCalled();
  });
  it("distinguishes the wrong Cloud account from missing sign-in and recovers on reconnect", async () => {
    h.identity.userId = "another-user";
    expect(await linkedServerSummary(row as never)).toMatchObject({ connectionIssue: "account_mismatch" });
    expect(h.fetch).not.toHaveBeenCalled();
    h.identity.userId = remote.userId;
    const result = await linkedServerSummary(row as never);
    expect(result).toMatchObject({ id: row.id, serverId: "local-server", state: "running", resources: summary.resources });
    expect(result).not.toHaveProperty("connectionIssue");
    expect(h.link).not.toHaveBeenCalled();
  });
  it("keeps temporary Cloud failure distinct from a disconnected account", async () => {
    h.fetch.mockResolvedValue(null);
    expect(await linkedServerSummary(row as never)).toMatchObject({ connectionIssue: "unavailable" });
  });
  it("offers sign-in when Cloud rejects an expired session without discarding the link", async () => {
    h.fetch.mockResolvedValue(json({ error: "Unauthorized", code: "UNAUTHORIZED" }, 401));
    expect(await linkedServerSummary(row as never)).toMatchObject({ connectionIssue: "not_connected" });
    expect(h.finishDeletion).not.toHaveBeenCalled();
  });
  it.each(["/managed/outbound", "/managed/outbound/options"])("reports an unsupported Cloud route for %s without bypassing Cloud", async suffix => {
    h.fetch.mockResolvedValue(new Response("404 Not Found", { status: 404 }));
    await expect(linkedServerRequest(row.organizationId, row.id, suffix)).rejects.toMatchObject({
      statusCode: 501, code: "CLOUD_SERVER_CONTROL_UNAVAILABLE",
    });
    expect(h.fetch).toHaveBeenCalledExactlyOnceWith(row.organizationId, `/api/system/servers/${remote.serverId}${suffix}`, undefined, remote);
  });
  it("preserves a structured resource 404 instead of mistaking it for an old API", async () => {
    h.fetch.mockResolvedValue(json({ error: "Server not found", code: "SERVER_NOT_FOUND" }, 404));
    await expect(linkedServerRequest(row.organizationId, row.id, "/managed/outbound")).rejects.toMatchObject({
      statusCode: 404, code: "SERVER_NOT_FOUND",
    });
  });
});

describe("linked server checkout recovery", () => {
  const ctx = { organizationId: row.organizationId } as never;
  const id = "a".repeat(64);
  const pending = { id, checkoutId: "cs_pending", server: summary, kind: "subscription", name: "Saved offer", amountCents: 1700,
    currency: "usd", interval: "monthly", state: "open", canResume: true, canCancel: true };
  it("maps both the billing owner and execution server using the verified Cloud link", async () => {
    h.proxy.mockResolvedValue({ status: 200, payload: { data: { items: [pending] } } });
    expect(await billingDependencies.collection.listCheckouts(ctx, { workspaceId: row.id })).toMatchObject({
      items: [{ id, server: { id: row.id, serverId: "local-server" } }],
    });
    expect(h.proxy).toHaveBeenCalledExactlyOnceWith(ctx, "/checkouts?workspaceId=cloud-workspace", "GET", undefined, remote);
    expect(h.audit).not.toHaveBeenCalled();
  });
  it.each(["resumeCheckout", "cancelCheckout"] as const)("forwards %s for the linked owner without rewriting the saved checkout identity", async operation => {
    h.proxy.mockResolvedValue({ status: 200, payload: { data: { status: "ready", checkoutId: "cs_pending", checkoutUrl: "https://checkout.stripe.com/private" } } });
    await billingDependencies.collection[operation](ctx, { workspaceId: row.id, id });
    expect(h.proxy).toHaveBeenCalledExactlyOnceWith(ctx, operation === "resumeCheckout" ? "/checkout/resume" : "/checkout/cancel", "POST",
      JSON.stringify({ workspaceId: remote.workspaceId, id }), remote);
    expect(JSON.stringify(h.audit.mock.calls)).not.toContain("https://checkout.stripe.com/private");
  });
  it.each(["id", "serverId"])("rejects an unrelated returned %s", async field => {
    h.proxy.mockResolvedValue({ status: 200, payload: { data: { items: [{ ...pending, server: { ...summary, [field]: "other" } }] } } });
    await expect(billingDependencies.collection.listCheckouts(ctx, { workspaceId: row.id }))
      .rejects.toMatchObject({ code: "CLOUD_SERVER_IDENTITY_MISMATCH" });
  });
  it.each([false, true])("keeps canonical server IDs when browsing Cloud inventory (existing local link: %s)", async hasLink => {
    h.workspaces.mockResolvedValue(hasLink ? [row] : []);
    h.proxy.mockResolvedValue({ status: 200, payload: { data: { items: [pending] } } });
    expect(await billingDependencies.collection.listCheckouts(ctx, { workspaceId: remote.workspaceId }))
      .toEqual({ items: [pending] });
    expect(h.proxy).toHaveBeenCalledExactlyOnceWith(ctx, "/checkouts?workspaceId=cloud-workspace", "GET", undefined, hasLink ? remote : undefined);
    expect(h.link).not.toHaveBeenCalled();
  });
  it("lists account-wide payments without creating local execution links", async () => {
    h.proxy.mockResolvedValue({ status: 200, payload: { data: { items: [pending] } } });
    expect(await billingDependencies.collection.listCheckouts(ctx, {})).toEqual({ items: [pending] });
    expect(h.proxy).toHaveBeenCalledExactlyOnceWith(ctx, "/checkouts", "GET", undefined, undefined);
    expect(h.link).not.toHaveBeenCalled();
  });
  it.each([
    { scopeMode: "fixed" },
    { tokenScope: { resourceType: "billing", resourceId: "*" } },
    { role: "restricted" },
    { credential: { organizationId: row.organizationId } },
  ])("requires locally scoped callers to use a verified local link: %j", async scope => {
    const scoped = { organizationId: row.organizationId, ...scope } as never;
    await expect(billingDependencies.collection.listCheckouts(scoped, {}))
      .rejects.toMatchObject({ code: "CLOUD_SCOPE_UNAVAILABLE" });
    await expect(billingDependencies.collection.listCheckouts(scoped, { workspaceId: remote.workspaceId }))
      .rejects.toMatchObject({ code: "CLOUD_SCOPE_UNAVAILABLE" });
    for (const operation of ["resumeCheckout", "cancelCheckout"] as const) {
      await expect(billingDependencies.collection[operation](scoped, { workspaceId: remote.workspaceId, id }))
        .rejects.toMatchObject({ code: "CLOUD_SCOPE_UNAVAILABLE" });
    }
    expect(h.proxy).not.toHaveBeenCalled();
  });
  it("does not fall back to Cloud for a local server owned by another organization", async () => {
    h.workspaceById.mockResolvedValue({ ...row, organizationId: "other-org" });
    h.workspace.mockResolvedValue(undefined);
    await expect(billingDependencies.collection.listCheckouts(ctx, { workspaceId: row.id }))
      .rejects.toMatchObject({ code: "CLOUD_WORKSPACE_NOT_FOUND" });
    expect(h.proxy).not.toHaveBeenCalled();
  });
  it("refuses to use a local link under another Cloud connection", async () => {
    h.identity.organizationId = "another-org";
    await expect(billingDependencies.collection.resumeCheckout(ctx, { workspaceId: row.id, id }))
      .rejects.toMatchObject({ code: "CLOUD_SERVER_CONNECTION_CHANGED" });
    expect(h.proxy).not.toHaveBeenCalled();
  });
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
