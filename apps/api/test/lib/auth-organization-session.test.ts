import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closeDb, db, eq, repos, schema } from "@repo/db";
import { auth } from "@repo/platform/engine/lib/auth";
import { provisionUser } from "@repo/platform/engine/lib/provision-user";

// Real Better Auth + Drizzle + migrated in-memory PGlite; no auth/repository mocks.
afterAll(() => closeDb());

let sequence = 0;
let organizationId: string;
let owner: string;
let member: string;

function headers(userId: string) {
  return { "Content-Type": "application/json", Authorization: `Bearer test-token-${userId}` };
}

function post(path: string, userId: string, body: unknown) {
  return auth.handler(
    new Request(`http://localhost:4000/api/auth/organization/${path}`, {
      method: "POST",
      headers: headers(userId),
      body: JSON.stringify(body),
    }),
  );
}

beforeEach(async () => {
  organizationId = `team-${sequence++}`;
  owner = `${organizationId}-owner`;
  member = `${organizationId}-member`;
  await db.insert(schema.organization).values({
    id: organizationId,
    name: "Empty team",
    slug: organizationId,
    isTeam: true,
  });
  for (const userId of [owner, member]) {
    await provisionUser({ id: userId, name: userId, email: `${userId}@example.test` });
    await db.insert(schema.member).values({
      id: `team-${userId}`,
      organizationId,
      userId,
      role: userId === owner ? "owner" : "member",
    });
    await db.insert(schema.session).values({
      id: `session-${userId}`,
      token: `test-token-${userId}`,
      userId,
      activeOrganizationId: organizationId,
      expiresAt: new Date(Date.now() + 60_000),
    });
  }
});

describe("Better Auth active organization sessions", () => {
  it.each([true, false])(
    "deletes a workspace (active=%s) and restores each session owner's personal workspace",
    async (active) => {
      if (!active)
        expect((await post("set-active", owner, { organizationId: `org_${owner}` })).status).toBe(
          200,
        );
      const secondSessionId = `second-${owner}`;
      await db.insert(schema.session).values({
        id: secondSessionId,
        token: secondSessionId,
        userId: owner,
        activeOrganizationId: organizationId,
        expiresAt: new Date(Date.now() + 60_000),
      });

      const response = await post("delete", owner, { organizationId });
      expect(response.status).toBe(200);
      expect(await repos.organization.findById(organizationId)).toBeFalsy();
      expect((await repos.session.findById(secondSessionId))?.activeOrganizationId).toBe(
        `org_${owner}`,
      );
      for (const userId of [owner, member]) {
        expect((await repos.session.findById(`session-${userId}`))?.activeOrganizationId).toBe(
          `org_${userId}`,
        );
        expect(await repos.member.find(`org_${userId}`, userId)).toBeTruthy();
        expect(
          (await auth.api.getSession({ headers: new Headers(headers(userId)) }))?.session
            .activeOrganizationId,
        ).toBe(`org_${userId}`);
      }
    },
  );

  it.each(["set-active", "leave"])("restores the personal workspace through %s", async (path) => {
    const response = await post(path, member, {
      organizationId: path === "set-active" ? null : organizationId,
    });
    expect(response.status).toBe(200);
    expect((await repos.session.findById(`session-${member}`))?.activeOrganizationId).toBe(
      `org_${member}`,
    );
    expect((await repos.session.findById(`session-${owner}`))?.activeOrganizationId).toBe(
      organizationId,
    );
    if (path === "leave") expect(await repos.member.find(organizationId, member)).toBeFalsy();
  });

  it("uses the stored session owner without request context and preserves ordinary updates", async () => {
    const { internalAdapter } = await auth.$context;
    await internalAdapter.updateSession(`test-token-${member}`, { userAgent: "regression-test" });
    expect((await repos.session.findById(`session-${member}`))?.activeOrganizationId).toBe(
      organizationId,
    );
    const updated = await internalAdapter.updateSession(`test-token-${member}`, {
      activeOrganizationId: null,
    });
    expect(updated?.activeOrganizationId).toBe(`org_${member}`);
    expect(updated?.userAgent).toBe("regression-test");
    expect((await repos.session.findById(`session-${owner}`))?.activeOrganizationId).toBe(
      organizationId,
    );
  });

  it("keeps deletion permissions and membership checks", async () => {
    expect((await post("delete", member, { organizationId })).status).toBe(403);
    expect(await repos.organization.findById(organizationId)).toBeTruthy();
    expect((await post("set-active", member, { organizationId: `org_${owner}` })).status).toBe(403);
    expect((await repos.session.findById(`session-${member}`))?.activeOrganizationId).toBe(
      `org_${member}`,
    );
  });

  it("keeps the billing deletion gate for an active workspace", async () => {
    await db
      .update(schema.organization)
      .set({ stripeCustomerId: "test-customer" })
      .where(eq(schema.organization.id, organizationId));
    const response = await post("delete", owner, { organizationId });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "ORG_DELETE_BILLING_ACTIVE" });
    expect(await repos.organization.findById(organizationId)).toBeTruthy();
  });

  it("keeps the managed network deletion gate for an active workspace", async () => {
    const [network] = await db
      .insert(schema.serverCluster)
      .values({
        organizationId,
        name: "Managed network",
        requestId: organizationId,
        inputHash: "test-input",
      })
      .returning();
    await db.insert(schema.clusterNetwork).values({
      clusterId: network!.id,
      mode: "wireguard",
      ownership: "openship",
      cidrs: ["10.42.0.0/24"],
      mtu: 1420,
      probePort: 51820,
    });
    const response = await post("delete", owner, { organizationId });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "ORG_DELETE_MANAGED_NETWORK_ACTIVE" });
    expect(await repos.organization.findById(organizationId)).toBeTruthy();
  });
});
