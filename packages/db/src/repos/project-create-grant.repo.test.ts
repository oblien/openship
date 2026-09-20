import { createEncryption } from "../encryption";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, createRepositories, schema, type DatabaseConnection } from "../factory";

describe("atomic project creation and credential access", () => {
  let connection: DatabaseConnection;
  let repos: ReturnType<typeof createRepositories>;
  beforeAll(async () => {
    connection = await createDatabase({ driver: "pglite", dataDir: "memory://" });
    repos = createRepositories(connection.db, createEncryption("repository-test-secret"));
    await connection.db.insert(schema.organization).values({ id: "org", name: "Test" });
  }, 30_000);
  afterAll(async () => { await connection?.close(); });

  async function input(id: string) {
    const groupId = `group-${id}`;
    await connection.db.insert(schema.projectGroup).values({ id: groupId, organizationId: "org", name: id, slug: id });
    return { id, groupId, organizationId: "org", name: id, slug: id };
  }
  async function token(id: string, extra: Partial<typeof schema.personalAccessToken.$inferInsert> = {}) {
    await connection.db.insert(schema.personalAccessToken).values({
      id, userId: "caller", organizationId: "org", name: id, tokenPrefix: "opsh_pat_", tokenHash: id, scoped: true, ...extra,
    });
  }

  it("commits the project with the creating token's exact project grant", async () => {
    await token("valid");
    const project = await repos.project.create(await input("created"), { tokenId: "valid" });
    expect((await repos.project.findById(project.id))?.organizationId).toBe("org");
    expect(await repos.patGrant.listByToken("valid")).toEqual([
      expect.objectContaining({ resourceType: "project", resourceId: project.id, permissions: ["read", "write", "admin"] }),
    ]);
  });

  it.each([
    ["missing", null], ["revoked", { revokedAt: new Date() }], ["expired", { expiresAt: new Date(0) }],
    ["readonly", { readOnly: true }], ["foreign", { organizationId: "another-org" }],
  ] as const)("leaves no project or grant for a %s credential", async (id, extra) => {
    if (extra) await token(id, extra);
    await expect(repos.project.create(await input(id), { tokenId: id })).rejects.toThrow();
    expect(await repos.project.findById(id)).toBeUndefined();
    expect(await repos.patGrant.listByToken(id)).toEqual([]);
  });

  it("rolls back the project when its grant cannot be inserted", async () => {
    await token("conflicting");
    await repos.patGrant.createMany("conflicting", [{ resourceType: "project", resourceId: "collision", permissions: ["read"] }]);
    await expect(repos.project.create(await input("collision"), { tokenId: "conflicting" })).rejects.toThrow();
    expect(await repos.project.findById("collision")).toBeUndefined();
    expect(await repos.patGrant.listByToken("conflicting")).toEqual([expect.objectContaining({ permissions: ["read"] })]);
  });
});
