import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { seedOwner, installFakeRunner, db, schema, repos, type SeededOwner } from "../jobs/_harness";
import { eq } from "@repo/db";
import { createShip, type VerifiedIdentity } from "@repo/sdk/native";
import { OpenshipClient } from "@repo/sdk/client";
import { getPlatformKernel } from "@repo/platform/engine/lib/platform";
import { flushAudit } from "@repo/platform/engine/lib/audit-emitter";
import { mintPatToken } from "@repo/platform/engine/lib/pat";
import { tokenRoutes } from "../../../src/modules/tokens/token.routes";
import { projectRoutes } from "../../../src/modules/projects/project.routes";
import { healthRoutes } from "../../../src/modules/health/health.routes";
import { handleApiError } from "../../../src/middleware/error-handler";

installFakeRunner();
const app = new Hono().onError(handleApiError).route("/api/health", healthRoutes).route("/api/tokens", tokenRoutes).route("/api/projects", projectRoutes);
function remote(owner: SeededOwner, token = owner.token) {
  return new OpenshipClient({ baseUrl: "http://openship.test", token, organizationId: owner.orgId, fetch: ((url, init) => app.request(url as string, init)) as typeof fetch });
}
async function clients(owner: SeededOwner, limits: Partial<VerifiedIdentity> = {}) {
  const user = (await repos.user.findById(owner.userId))!;
  const ship = createShip({ platform: getPlatformKernel(), identity: { resolve: async () => ({ user: { id: user.id, email: user.email, name: user.name }, sessionId: "tokens-test", ...limits }) } });
  return { native: await ship.scope({ identity: "verified", organizationId: owner.orgId }), remote: remote(owner) };
}
async function project(owner: SeededOwner, name: string) {
  const input = { organizationId: owner.orgId, name, slug: `${owner.userId}-${name}`, gitProvider: "upload" };
  const group = await repos.projectGroup.create(input);
  return repos.project.create({ ...input, groupId: group.id });
}

describe("token lifecycle shared by native SDK and HTTP", () => {
  it("mints a working scoped credential, reveals it once, and revokes it through either interface", async () => {
    const owner = await seedOwner(), p = await project(owner, "allowed"), hidden = await project(owner, "hidden"), c = await clients(owner);
    const issued = await c.native.tokens.create({ name: "Deploy reader", grants: [{ resourceType: "project", resourceId: p.id, permissions: ["read"] }] });
    expect(issued.token).toMatch(/^opsh_pat_/);
    expect(issued.scoped).toBe(true);
    const actor = remote(owner, issued.token);
    expect((await actor.projects.get(p.id)).id).toBe(p.id);
    await expect(actor.projects.get(hidden.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    const listed = await c.remote.tokens.list();
    expect(listed.find(row => row.id === issued.id)).toMatchObject({ name: issued.name, scoped: true, createdAt: issued.createdAt });
    expect(JSON.stringify(listed)).not.toContain(issued.token);
    expect(JSON.stringify(listed)).not.toContain("tokenHash");
    await c.remote.tokens.revoke(issued.id);
    await expect(actor.projects.get(p.id)).rejects.toMatchObject({ status: 401 });
    expect((await c.native.tokens.list()).find(row => row.id === issued.id)?.revokedAt).toEqual(expect.any(String));
  });

  it("refuses implicit full access and cross-user or cross-tenant credential changes", async () => {
    const owner = await seedOwner(), other = await seedOwner(), foreign = await project(other, "foreign"), c = await clients(owner);
    const otherToken = (await repos.personalAccessToken.listByUser(other.userId))[0]!;
    for (const client of [c.native.tokens, c.remote.tokens]) {
      await expect(client.create({ name: "No intent" })).rejects.toMatchObject({ code: "TOKEN_SCOPE_REQUIRED" });
      await expect(client.create({ name: "Foreign", grants: [{ resourceType: "project", resourceId: foreign.id, permissions: ["read"] }] })).rejects.toMatchObject({ code: "GRANT_EXCEEDS_ACCESS" });
      await expect(client.revoke(otherToken.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(client.authorizeMcpClient({ clientId: "foreign-agent", organizationId: other.orgId, fullAccess: true })).rejects.toMatchObject({ code: "TOKEN_ORG_SCOPE" });
    }
    expect(await repos.personalAccessToken.listByUser(owner.userId)).toHaveLength(1);
  });

  it("prevents a scoped settings grant from minting an unrestricted token or OAuth binding", async () => {
    const owner = await seedOwner(), c = await clients(owner);
    const issued = await c.native.tokens.create({ name: "Settings agent", grants: [{ resourceType: "settings", resourceId: "*", permissions: ["write"] }] });
    const limited = await clients(owner, { sessionId: `pat:${issued.id}`, principalKind: "pat", tokenScope: { tokenId: issued.id }, credential: { organizationId: owner.orgId, readOnly: false } });
    for (const client of [limited.native.tokens, remote(owner, issued.token).tokens]) {
      await expect(client.create({ name: "Escalation", fullAccess: true })).rejects.toMatchObject({ code: "CREDENTIAL_MANAGEMENT_DENIED" });
      await expect(client.authorizeMcpClient({ clientId: "escalation-agent", fullAccess: true })).rejects.toMatchObject({ code: "CREDENTIAL_MANAGEMENT_DENIED" });
    }
    expect(await repos.personalAccessToken.listByUser(owner.userId)).toHaveLength(2);
    expect(await repos.personalAccessToken.findOAuthBinding(owner.userId, "escalation-agent")).toBeNull();
    // Revoking itself is safe and remains possible.
    await remote(owner, issued.token).tokens.revoke(issued.id);
  });

  it("uses the same MCP binding, explicit widening and atomic disconnect with audit attribution", async () => {
    const owner = await seedOwner(), p = await project(owner, "mcp"), c = await clients(owner);
    const grants = [{ resourceType: "project", resourceId: p.id, permissions: ["read"] as "read"[] }];
    await c.native.tokens.authorizeMcpClient({ clientId: "sdk-agent", grants });
    const detail = await c.remote.tokens.getMcpClient("sdk-agent");
    expect(detail).toEqual(await c.native.tokens.getMcpClient("sdk-agent"));
    expect(detail.grants).toEqual(grants);
    await expect(c.remote.tokens.authorizeMcpClient({ clientId: "sdk-agent", mode: "edit", fullAccess: true })).rejects.toMatchObject({ code: "SCOPE_WIDEN_NOT_CONFIRMED" });
    await c.remote.tokens.authorizeMcpClient({ clientId: "sdk-agent", mode: "edit", fullAccess: true, confirmWiden: true });
    expect((await c.native.tokens.listMcpClients())[0]?.scoped).toBe(false);
    await c.native.tokens.disconnectMcpClient("sdk-agent");
    expect(await c.remote.tokens.listMcpClients()).toEqual([]);
    await flushAudit();
    const events = await db.select().from(schema.auditEvent).where(eq(schema.auditEvent.organizationId, owner.orgId));
    expect(events.map(row => row.eventType).sort()).toEqual(["mcp.authorized", "mcp.disconnected", "mcp.scope_changed"]);
  });

  it("caps new token expiry at the caller's trusted credential lifetime", async () => {
    const owner = await seedOwner(), expiresAt = Date.now() + 60_000;
    const c = await clients(owner, { credential: { organizationId: owner.orgId, readOnly: false, expiresAt } });
    const issued = await c.native.tokens.create({ name: "Temporary", fullAccess: true });
    expect(Date.parse(issued.expiresAt!)).toBe(expiresAt);
    await c.native.tokens.authorizeMcpClient({ clientId: "temporary-agent", fullAccess: true });
    const binding = (await repos.personalAccessToken.findOAuthBinding(owner.userId, "temporary-agent"))!;
    expect(binding.expiresAt?.getTime()).toBe(expiresAt);
    expect((await c.remote.tokens.getMcpClient("temporary-agent")).expiresAt).toBe(new Date(expiresAt).toISOString());
    await db.update(schema.personalAccessToken).set({ expiresAt: new Date(Date.now() - 1_000) }).where(eq(schema.personalAccessToken.id, binding.id));
    expect(await repos.personalAccessToken.findOAuthBinding(owner.userId, "temporary-agent")).toBeNull();
    expect(await c.remote.tokens.listMcpClients()).toEqual([]);
  });

  it("confines credential management to the selected tenant, including another tenant of the same user", async () => {
    const owner = await seedOwner(), other = await seedOwner(), c = await clients(owner);
    const values = mintPatToken();
    const token = await repos.personalAccessToken.create({ userId: owner.userId, organizationId: other.orgId, name: "Other workspace", tokenPrefix: values.tokenPrefix, tokenHash: values.tokenHash, readOnly: false, expiresAt: null });
    await repos.personalAccessToken.upsertOAuthBindingWithGrants({ userId: owner.userId, organizationId: other.orgId, oauthClientId: "other-workspace", scoped: false, readOnly: false, unrevoke: true, grants: [] });
    for (const client of [c.native.tokens, c.remote.tokens]) {
      expect((await client.list()).some(row => row.id === token.id)).toBe(false);
      expect(await client.listMcpClients()).toEqual([]);
      await expect(client.revoke(token.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(client.getMcpClient("other-workspace")).rejects.toMatchObject({ code: "MCP_CLIENT_NOT_CONNECTED" });
      await expect(client.disconnectMcpClient("other-workspace")).rejects.toMatchObject({ code: "MCP_CLIENT_NOT_CONNECTED" });
    }
    expect(await repos.personalAccessToken.findActiveByHash(values.tokenHash)).not.toBeNull();
  });

  it("does not recreate an OAuth binding if disconnect wins a concurrent edit", async () => {
    const owner = await seedOwner(), c = await clients(owner);
    await c.native.tokens.authorizeMcpClient({ clientId: "disconnected", fullAccess: true });
    await c.native.tokens.disconnectMcpClient("disconnected");
    await expect(repos.personalAccessToken.upsertOAuthBindingWithGrants({ userId: owner.userId, organizationId: owner.orgId, oauthClientId: "disconnected", readOnly: false, scoped: false, unrevoke: false, grants: [] })).rejects.toMatchObject({ code: "MCP_CLIENT_NOT_CONNECTED" });
    expect(await repos.personalAccessToken.findOAuthBinding(owner.userId, "disconnected")).toBeNull();
  });

  it("rolls back a token when its grant insert fails", async () => {
    const owner = await seedOwner(), values = mintPatToken();
    const input = { userId: owner.userId, organizationId: owner.orgId, name: "Atomic", tokenPrefix: values.tokenPrefix, tokenHash: values.tokenHash, readOnly: false, scoped: true, expiresAt: null };
    const grant = { resourceType: "settings" as const, resourceId: "*", permissions: ["read"] as "read"[] };
    await expect(repos.personalAccessToken.createWithGrants(input, [grant, grant])).rejects.toBeDefined();
    expect(await repos.personalAccessToken.findActiveByHash(values.tokenHash)).toBeNull();
    expect(await repos.personalAccessToken.listByUser(owner.userId)).toHaveLength(1);
  });
});
