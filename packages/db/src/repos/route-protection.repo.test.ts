import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDatabase, createRepositories, schema, type DatabaseConnection } from "../factory";
import { createEncryption } from "../encryption";
import { stripEncryptedInPlace, stripInstanceRefsInPlace, topoOrderedTables } from "../dump";

describe("private route credentials", () => {
  const encryption = createEncryption("route-protection-test-key");
  let connection: DatabaseConnection;
  let repos: ReturnType<typeof createRepositories>;
  let projectId: string;
  beforeAll(async () => {
    connection = await createDatabase({ driver: "pglite", dataDir: "memory://" });
    repos = createRepositories(connection.db, encryption);
    await connection.db.insert(schema.organization).values({ id: "route-org", name: "Test" });
    const group = await repos.projectGroup.create({
      organizationId: "route-org",
      name: "Private",
      slug: "private",
    });
    const project = await repos.project.create({
      groupId: group.id,
      organizationId: "route-org",
      name: "Private",
      slug: "private",
    });
    projectId = project.id;
  });
  afterAll(async () => {
    await connection?.close();
    encryption.close();
  });

  it("seals credentials, scopes private reads, and only acknowledges the current revision", async () => {
    await repos.routeProtection.save(projectId, "private.test", "first", "secret-policy-one");
    const first = await repos.routeProtection.readPrivate(projectId, "private.test");
    expect(first?.secret).toBe("secret-policy-one");
    expect(await repos.routeProtection.readPrivate("another-project", "private.test")).toBeNull();
    const [stored] = await connection.db.select().from(schema.routeProtection);
    expect(stored.secret).not.toContain("secret-policy");
    expect(JSON.stringify(await repos.routeProtection.list(projectId))).not.toContain("secret");

    await repos.routeProtection.save(projectId, "private.test", "second", "secret-policy-two");
    await repos.routeProtection.markApplied(projectId, "private.test", "first");
    expect((await repos.routeProtection.list(projectId))[0].appliedRevision).toBeNull();
    await repos.routeProtection.markApplied(projectId, "private.test", "second");
    expect((await repos.routeProtection.list(projectId))[0].appliedRevision).toBe("second");
    expect((await repos.routeProtection.readPrivate(projectId, "private.test"))?.id).toBe(
      first?.id,
    );

    await repos.routeProtection.save(projectId, "private.test", "unlock", null);
    expect((await repos.routeProtection.list(projectId))[0]).toMatchObject({
      enabled: false,
      appliedRevision: null,
    });
  });

  it("exports lock intent even without secrets and discards the source edge's applied receipt", async () => {
    const tables = {
      route_protection: [
        {
          id: "rp",
          projectId,
          hostname: "private.test",
          enabled: true,
          secret: "sealed-value",
          revision: "v1",
          appliedRevision: "v1",
        },
      ],
    };
    stripEncryptedInPlace(tables);
    stripInstanceRefsInPlace(tables);
    expect(tables.route_protection[0]).toMatchObject({
      enabled: true,
      secret: null,
      appliedRevision: null,
    });
    const catalog = topoOrderedTables();
    expect(catalog.findIndex((t) => t.sqlName === "route_protection")).toBeGreaterThan(
      catalog.findIndex((t) => t.sqlName === "project"),
    );
  });

  it("refuses configuration changes once project cleanup owns the row", async () => {
    await connection.db
      .update(schema.project)
      .set({
        deletionInProgress: true,
        lifecycleOperation: { kind: "delete", status: "failed" } as never,
      })
      .where(eq(schema.project.id, projectId));
    await expect(
      repos.routeProtection.save(projectId, "blocked.test", "new", "secret"),
    ).rejects.toMatchObject({ code: "PROJECT_DELETION_PENDING" });
    expect(await repos.routeProtection.readPrivate(projectId, "blocked.test")).toBeNull();
  });
});
