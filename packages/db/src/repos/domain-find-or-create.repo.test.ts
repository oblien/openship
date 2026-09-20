import { beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/pglite/migrator";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as schema from "../schema";
import type { Database } from "../client";
import { createDomainRepo } from "./domain.repo";

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../drizzle");

describe("domain.findOrCreateWithStatus", () => {
  let repo: ReturnType<typeof createDomainRepo>;
  let db: Database;

  beforeAll(async () => {
    const client = new PGlite("memory://");
    db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
    // This repository contract does not depend on parent-row behavior. Disabling
    // FK triggers keeps the fixture focused and mirrors the other repo tests.
    await client.exec("SET session_replication_role = replica;");
    repo = createDomainRepo(db);
  }, 30_000);

  it("reports true only for the call that inserted the hostname", async () => {
    const input = {
      projectId: "proj_a",
      hostname: "App.Example.com",
      domainType: "custom",
      status: "pending",
      verified: false,
      isPrimary: false,
    };

    const first = await repo.findOrCreateWithStatus(input);
    const second = await repo.findOrCreateWithStatus(input);

    expect(first).toMatchObject({ created: true, domain: { hostname: "app.example.com" } });
    expect(second).toMatchObject({ created: false, domain: { id: first.domain.id } });
  });

  it("keeps the compatibility method returning the domain row", async () => {
    const row = await repo.findOrCreate({
      projectId: "proj_a",
      hostname: "other.example.com",
      domainType: "custom",
    });

    expect(row).toMatchObject({ hostname: "other.example.com", projectId: "proj_a" });
  });

  it("reserves a hostname until deferred route cleanup has completed", async () => {
    await db.insert(schema.orphanedResource).values({
      id: "orph_route",
      organizationId: "org_a",
      projectId: "deleted_project",
      resourceType: "route",
      ref: "reserved.example.com",
      runtimeMode: "docker",
    });

    await expect(
      repo.create({
        projectId: "proj_a",
        hostname: "reserved.example.com",
        domainType: "custom",
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    await db.delete(schema.orphanedResource);
    await expect(
      repo.create({
        projectId: "proj_a",
        hostname: "reserved.example.com",
        domainType: "custom",
      }),
    ).resolves.toMatchObject({ hostname: "reserved.example.com" });
  });

  it("atomically demotes other project domains when domain.update promotes one", async () => {
    const first = await repo.create({
      projectId: "proj_primary_test",
      hostname: "primary-first.example.com",
      domainType: "free",
      isPrimary: true,
    });

    const second = await repo.create({
      projectId: "proj_primary_test",
      hostname: "primary-second.example.com",
      domainType: "custom",
      isPrimary: false,
    });

    await repo.update(second.id, { isPrimary: true, targetPort: 4321 });

    const firstUpdated = await repo.findById(first.id);
    const secondUpdated = await repo.findById(second.id);

    expect(secondUpdated?.isPrimary).toBe(true);
    expect(secondUpdated?.targetPort).toBe(4321);
    expect(firstUpdated?.isPrimary).toBe(false);
  });

  it("keeps the previous primary when the promoted row patch fails", async () => {
    const first = await repo.create({
      projectId: "proj_failed_promotion",
      hostname: "kept-primary.example.com",
      isPrimary: true,
    });
    const second = await repo.create({
      projectId: "proj_failed_promotion",
      hostname: "failed-primary.example.com",
      isPrimary: false,
    });

    await expect(
      repo.update(second.id, { isPrimary: true, hostname: first.hostname }),
    ).rejects.toThrow();

    await expect(repo.findById(first.id)).resolves.toMatchObject({ isPrimary: true });
    await expect(repo.findById(second.id)).resolves.toMatchObject({ isPrimary: false });
  });

  it("routes primary creates through the same promotion invariant", async () => {
    const first = await repo.create({
      projectId: "proj_create_primary",
      hostname: "first-created.example.com",
      isPrimary: true,
    });
    const second = await repo.create({
      projectId: "proj_create_primary",
      hostname: "second-created.example.com",
      isPrimary: true,
    });

    await expect(repo.findById(first.id)).resolves.toMatchObject({ isPrimary: false });
    await expect(repo.findById(second.id)).resolves.toMatchObject({ isPrimary: true });
  });

  it("routes primary find-or-create inserts through the same promotion invariant", async () => {
    const first = await repo.create({
      projectId: "proj_find_or_create_primary",
      hostname: "first-found.example.com",
      isPrimary: true,
    });
    const second = await repo.findOrCreateWithStatus({
      projectId: "proj_find_or_create_primary",
      hostname: "second-found.example.com",
      isPrimary: true,
    });

    expect(second.created).toBe(true);
    expect(second.domain.isPrimary).toBe(true);
    await expect(repo.findById(first.id)).resolves.toMatchObject({ isPrimary: false });
  });

  it("enforces one primary per project for writes outside the repository", async () => {
    const first = await repo.create({
      projectId: "proj_unique_primary",
      hostname: "guarded-primary.example.com",
      isPrimary: true,
    });
    const second = await repo.create({
      projectId: "proj_unique_primary",
      hostname: "guarded-secondary.example.com",
      isPrimary: false,
    });

    await expect(
      db.update(schema.domain).set({ isPrimary: true }).where(eq(schema.domain.id, second.id)),
    ).rejects.toThrow();
    await expect(repo.findById(first.id)).resolves.toMatchObject({ isPrimary: true });
  });

  it("repairs legacy duplicate primaries before installing the unique index", async () => {
    const legacy = new PGlite("memory://");
    try {
      await legacy.exec(`
        CREATE TABLE "domain" (
          "id" text PRIMARY KEY,
          "project_id" text,
          "is_primary" boolean NOT NULL DEFAULT false,
          "created_at" timestamp NOT NULL,
          "updated_at" timestamp NOT NULL
        );
        INSERT INTO "domain" VALUES
          ('old', 'proj_legacy', true, '2026-01-01', '2026-01-02'),
          ('new', 'proj_legacy', true, '2026-01-03', '2026-01-04');
      `);
      const migration = readFileSync(
        resolve(MIGRATIONS_DIR, "0120_domain_primary_unique.sql"),
        "utf8",
      ).replaceAll("--> statement-breakpoint", "");
      await legacy.exec(migration);

      const result = await legacy.query<{ id: string; is_primary: boolean }>(
        `SELECT id, is_primary FROM "domain" ORDER BY id`,
      );
      expect(result.rows).toEqual([
        { id: "new", is_primary: true },
        { id: "old", is_primary: false },
      ]);
      await expect(
        legacy.exec(`UPDATE "domain" SET "is_primary" = true WHERE "id" = 'old'`),
      ).rejects.toThrow();
    } finally {
      await legacy.close();
    }
  });
});
