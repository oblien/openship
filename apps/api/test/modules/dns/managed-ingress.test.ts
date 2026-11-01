import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { db, repos, schema } from "@repo/db";
import { eq } from "drizzle-orm";
import { OpenshipClient } from "@repo/sdk/client";
import { seedOwner, seedServer } from "../jobs/_harness";
import { seedProject } from "../../helpers/seed";
import { dnsRoutes } from "../../../src/modules/dns/dns.routes";
import { healthRoutes } from "../../../src/modules/health/health.routes";
import { handleApiError } from "../../../src/middleware/error-handler";
const app = new Hono()
  .onError(handleApiError)
  .route("/api/dns", dnsRoutes)
  .route("/api/health", healthRoutes);
function client(owner: Awaited<ReturnType<typeof seedOwner>>) {
  return new OpenshipClient({
    baseUrl: "http://openship.test",
    token: owner.token,
    organizationId: owner.orgId,
    fetch: ((url, init) => app.request(url as string, init)) as typeof fetch,
  });
}
describe("managed ingress through authenticated HTTP and the public SDK", () => {
  it("returns organization-scoped connection and hostname receipts without credentials", async () => {
    const owner = await seedOwner(),
      other = await seedOwner(),
      server = await seedServer(owner.orgId),
      project = await seedProject(owner.orgId, { serverId: server });
    await db
      .insert(schema.credential)
      .values({
        id: "credential_http_ingress",
        organizationId: owner.orgId,
        provider: "cloudflare",
        name: "Private credential",
        secretsEnc: "enc1:never-return-this",
      });
    const c = await repos.ingress.create({
      id: "igc_http",
      organizationId: owner.orgId,
      serverId: server,
      credentialId: "credential_http_ingress",
      accountId: "account",
      tunnelId: "tunnel",
      name: "Existing tunnel",
      connector: "existing",
      status: "ready",
    });
    const d = await repos.domain.create({
      projectId: project.id,
      hostname: "sdk-ingress.example.test",
      domainType: "custom",
    });
    await repos.ingress.bindDomain(d.id, c.id, null);
    expect(await client(owner).dns.listIngressConnections({ serverId: server })).toEqual([
      expect.objectContaining({ id: c.id, status: "ready" }),
    ]);
    expect(JSON.stringify(await client(owner).dns.listIngressConnections({}))).not.toMatch(
      /never-return-this|secretsEnc|ownership/,
    );
    expect(await client(owner).dns.getDomainIngress({ domainId: d.id })).toMatchObject({
      hostname: d.hostname,
      connectionId: c.id,
      status: "pending",
    });
    expect(await client(other).dns.listIngressConnections({ serverId: server })).toEqual([]);
    await expect(client(other).dns.getDomainIngress({ domainId: d.id })).rejects.toMatchObject({
      status: 404,
    });
  });
  it("requires organization admin for discovery and validates path/body identity separately", async () => {
    const owner = await seedOwner();
    const headers = {
      ...owner.auth,
      "x-organization-id": owner.orgId,
      "content-type": "application/json",
    };
    const invalid = await app.request("/api/dns/ingress/igc_path", {
      method: "PUT",
      headers,
      body: JSON.stringify({
        id: "different",
        defaultForDomains: false,
        defaultAccessPolicyId: null,
      }),
    });
    expect(invalid.status).toBe(400);
    await db
      .update(schema.member)
      .set({ role: "member" })
      .where(eq(schema.member.userId, owner.userId));
    const denied = await app.request("/api/dns/ingress/discover", {
      method: "POST",
      headers,
      body: JSON.stringify({ credentialId: "no-secret" }),
    });
    expect(denied.status).toBe(403);
  });
});
