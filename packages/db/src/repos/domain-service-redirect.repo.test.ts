import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq } from "drizzle-orm";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as schema from "../schema";
import type { ServicePublicEndpoint } from "../schema/service";
import { createDomainRepo } from "./domain.repo";

describe("service domain redirect persistence", () => {
  const client = new PGlite("memory://");
  const db = drizzle(client, { schema });
  const repo = createDomainRepo(db);
  let sequence = 0;

  beforeAll(async () => {
    await migrate(db, {
      migrationsFolder: resolve(dirname(fileURLToPath(import.meta.url)), "../../drizzle"),
    });
    await client.exec("SET session_replication_role = replica;");
  }, 30_000);
  afterAll(async () => {
    await client.close();
  });

  async function seed() {
    const id = `redirect-${sequence++}`;
    const primary = `${id}.example.com`;
    const alias = `alias-${primary}`;
    await db.insert(schema.project).values({
      id,
      organizationId: "org_redirect",
      groupId: id,
      name: id,
      slug: id,
    });
    const endpoints: ServicePublicEndpoint[] = [
      { port: 3000, domainType: "custom", customDomain: primary, redirectTo: "" },
      { port: 3000, domainType: "custom", customDomain: alias, redirectTo: "" },
    ];
    await db.insert(schema.service).values({
      id,
      projectId: id,
      name: "web",
      publicEndpoints: endpoints,
      updatedAt: new Date(0),
    });
    const domain = await repo.create({
      projectId: id,
      serviceId: id,
      hostname: alias,
      domainType: "custom",
      targetPort: 3000,
    });
    const readService = () => db.query.service.findFirst({ where: eq(schema.service.id, id) });
    return { id, primary, alias, endpoints, domain, readService };
  }

  it.each([false, true])(
    "updates the matching endpoint atomically with the domain (primary: %s)",
    async (isPrimary) => {
      const s = await seed();
      await repo.update(s.domain.id, { redirectTo: s.primary, redirectStatus: 308, isPrimary });
      expect(await repo.findById(s.domain.id)).toMatchObject({
        redirectTo: s.primary,
        redirectStatus: 308,
        isPrimary,
      });
      expect((await s.readService())?.publicEndpoints).toEqual([
        s.endpoints[0],
        { ...s.endpoints[1], redirectTo: s.primary, redirectStatus: 308 },
      ]);
      await repo.update(s.domain.id, { redirectStatus: 302 });
      expect((await s.readService())?.publicEndpoints?.[1]?.redirectStatus).toBe(302);
      await repo.update(s.domain.id, { redirectTo: null, redirectStatus: null });
      expect((await s.readService())?.publicEndpoints).toEqual(s.endpoints);
    },
  );

  it("rolls the domain back if its service endpoint cannot be saved", async () => {
    const s = await seed();
    await client.exec(`ALTER TABLE service ADD CONSTRAINT redirect_write_guard
      CHECK (public_endpoints #>> '{1,redirectTo}' <> 'blocked.example.com');`);
    try {
      await expect(
        repo.update(s.domain.id, {
          redirectTo: "blocked.example.com",
          redirectStatus: 301,
        }),
      ).rejects.toThrow();
      expect(await repo.findById(s.domain.id)).toMatchObject({
        redirectTo: null,
        redirectStatus: null,
      });
      expect((await s.readService())?.publicEndpoints).toEqual(s.endpoints);
    } finally {
      await client.exec("ALTER TABLE service DROP CONSTRAINT redirect_write_guard;");
    }
  });

  it("does not update a service linked from another project", async () => {
    const s = await seed();
    await repo.update(s.domain.id, {
      projectId: "another_project",
      redirectTo: s.primary,
      redirectStatus: 301,
    });
    expect(await s.readService()).toMatchObject({
      publicEndpoints: s.endpoints,
      updatedAt: new Date(0),
    });
  });

  it("leaves the service configuration untouched during certificate and verification updates", async () => {
    const s = await seed();
    const before = await s.readService();
    await repo.update(s.domain.id, { verified: true, sslStatus: "active" });
    expect(await s.readService()).toEqual(before);
  });
});
