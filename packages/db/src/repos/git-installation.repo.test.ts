import { beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as schema from "../schema";
import type { Database } from "../client";
import { createGitInstallationRepo } from "./git-installation.repo";
import { createGitSourceRepo } from "./git-source.repo";

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../drizzle");

describe("gitInstallation workspace boundary", () => {
  let repo: ReturnType<typeof createGitInstallationRepo>;
  let sourceRepo: ReturnType<typeof createGitSourceRepo>;
  let db: Database;

  beforeAll(async () => {
    const client = new PGlite("memory://");
    db = drizzle(client, { schema }) as Database;
    await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
    await client.exec("SET session_replication_role = replica;");
    repo = createGitInstallationRepo(db);
    sourceRepo = createGitSourceRepo(db);
  }, 30_000);

  const row = (organizationId: string, userId: string, installationId: number) => ({
    userId,
    organizationId,
    provider: "github",
    installationId,
    owner: "Acme",
    ownerType: "Organization",
    providerOwnerId: "700",
    isOrg: true,
  });

  it("allows the same GitHub installation to be claimed by two workspaces", async () => {
    await repo.upsert(row("org_one", "user_one", 42));
    await repo.upsert(row("org_two", "user_one", 42));

    await expect(repo.listByOrganization("org_one")).resolves.toHaveLength(1);
    await expect(repo.listByOrganization("org_two")).resolves.toHaveLength(1);
  });

  it("converges reconnects inside one workspace instead of duplicating rows", async () => {
    await repo.upsert(row("org_reconnect", "user_old", 40));
    await repo.upsert(row("org_reconnect", "user_new", 41));

    const rows = await repo.listByOrganization("org_reconnect");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      organizationId: "org_reconnect",
      userId: "user_new",
      installationId: 41,
      owner: "acme",
    });
  });

  it("retains but excludes a suspended binding, then restores it on unsuspend", async () => {
    await repo.upsert(row("org_suspend", "user_one", 99));
    await repo.suspendByInstallationIdForProvider(99);

    await expect(repo.listByOrganization("org_suspend")).resolves.toEqual([]);
    await expect(repo.findByInstallationIdForProvider(99)).resolves.toHaveLength(1);

    // installation.unsuspend goes through the normal upsert and clears the flag.
    await repo.upsert(row("org_suspend", "user_one", 99));
    await expect(repo.listByOrganization("org_suspend")).resolves.toHaveLength(1);
  });

  it("atomically claims state and rebinds projects after a GitHub App reinstall", async () => {
    await db.insert(schema.projectGroup).values({
      id: "app_rebind",
      organizationId: "org_rebind",
      name: "Existing app",
      slug: "existing-app",
      gitProvider: "github",
      gitOwner: "Acme",
      gitRepo: "site",
      installationId: 40,
    });
    await db.insert(schema.project).values({
      id: "prj_rebind",
      organizationId: "org_rebind",
      groupId: "app_rebind",
      name: "Existing app",
      slug: "existing-app",
      environmentSlug: "production",
      gitProvider: "github",
      gitOwner: "ACME",
      gitRepo: "site",
      installationId: 40,
      webhookId: 77,
      webhookSecret: "encrypted-old-secret",
    });

    await db.insert(schema.githubInstallState).values({
      id: "gis_rebind",
      state: "nonce_rebind",
      userId: "user_rebind",
      organizationId: "org_rebind",
      expiresAt: new Date(Date.now() + 60_000),
    });
    await expect(
      repo.claimWithState("nonce_rebind", row("org_rebind", "user_rebind", 99)),
    ).resolves.toMatchObject({ installationId: 99, owner: "acme" });

    await expect(
      db.query.project.findFirst({
        where: (table, { eq }) => eq(table.id, "prj_rebind"),
      }),
    ).resolves.toMatchObject({
      installationId: 99,
      webhookId: null,
      webhookSecret: null,
    });
    await expect(
      db.query.projectGroup.findFirst({
        where: (table, { eq }) => eq(table.id, "app_rebind"),
      }),
    ).resolves.toMatchObject({ installationId: 99 });
    await expect(
      db.query.githubInstallState.findFirst({
        where: (table, { eq }) => eq(table.state, "nonce_rebind"),
      }),
    ).resolves.toBeUndefined();
    await expect(
      repo.claimWithState("nonce_rebind", row("org_rebind", "user_rebind", 100)),
    ).resolves.toBeNull();
  });

  it("makes a selected source effective for existing projects and promotes a replacement on delete", async () => {
    const org = "org_custom_default";
    const first = await sourceRepo.create({
      organizationId: org,
      name: "First App",
      appId: 501,
      slug: "first-app",
      clientId: null,
      appName: "First App",
      avatarUrl: null,
      apiBaseUrl: "https://api.github.com",
      webBaseUrl: "https://github.com",
      webhookUrl: "https://openship.example/api/webhooks/github",
      secretsEnc: "enc1:first",
      status: "active",
      lastVerifiedAt: new Date(),
      lastError: null,
    });
    const second = await sourceRepo.create({
      organizationId: org,
      name: "Second App",
      appId: 502,
      slug: "second-app",
      clientId: null,
      appName: "Second App",
      avatarUrl: null,
      apiBaseUrl: "https://api.github.com",
      webBaseUrl: "https://github.com",
      webhookUrl: "https://openship.example/api/webhooks/github",
      secretsEnc: "enc1:second",
      status: "active",
      lastVerifiedAt: new Date(),
      lastError: null,
    });
    await repo.upsert({ ...row(org, "user_one", 501), sourceId: first.id });
    await repo.upsert({ ...row(org, "user_one", 502), sourceId: second.id });
    await db.insert(schema.projectGroup).values({
      id: "app_custom_default",
      organizationId: org,
      name: "Custom source app",
      slug: "custom-source-app",
      gitProvider: "github",
      gitOwner: "Acme",
      gitRepo: "site",
      installationId: 501,
    });
    await db.insert(schema.project).values({
      id: "prj_custom_default",
      organizationId: org,
      groupId: "app_custom_default",
      name: "Custom source app",
      slug: "custom-source-app",
      environmentSlug: "production",
      gitProvider: "github",
      gitOwner: "ACME",
      gitRepo: "site",
      installationId: 501,
      webhookId: 77,
      webhookSecret: "old-project-hook",
    });
    await db.insert(schema.resourceGrant).values({
      id: "grant_custom_default",
      organizationId: org,
      userId: "member_one",
      resourceType: "github_repository",
      resourceId: "Acme/site",
      permissionsJson: '["read"]',
    });

    await expect(sourceRepo.setDefault(org, second.id)).resolves.toMatchObject({
      id: second.id,
      isDefault: true,
    });
    await expect(repo.findByOrgAndOwner(org, "acme")).resolves.toMatchObject({
      sourceId: second.id,
      installationId: 502,
    });
    await expect(
      db.query.project.findFirst({
        where: (table, { eq }) => eq(table.id, "prj_custom_default"),
      }),
    ).resolves.toMatchObject({
      installationId: 502,
      webhookId: null,
      webhookSecret: null,
    });

    await expect(repo.removeSourceAndRebind(org, second.id)).resolves.toMatchObject({
      id: second.id,
    });
    await expect(sourceRepo.findDefault(org)).resolves.toMatchObject({ id: first.id });
    await expect(
      db.query.project.findFirst({
        where: (table, { eq }) => eq(table.id, "prj_custom_default"),
      }),
    ).resolves.toMatchObject({ installationId: 501 });
    await expect(
      db.query.resourceGrant.findFirst({
        where: (table, { eq }) => eq(table.id, "grant_custom_default"),
      }),
    ).resolves.toBeDefined();
  });

  it("prunes owner grants when source deletion leaves no replacement installation", async () => {
    const org = "org_source_grants";
    const source = await sourceRepo.create({
      organizationId: org,
      name: "Only App",
      appId: 601,
      slug: "only-app",
      clientId: null,
      appName: "Only App",
      avatarUrl: null,
      apiBaseUrl: "https://api.github.com",
      webBaseUrl: "https://github.com",
      webhookUrl: "https://openship.example/api/webhooks/github",
      secretsEnc: "enc1:only",
      status: "active",
      lastVerifiedAt: new Date(),
      lastError: null,
    });
    await repo.upsert({ ...row(org, "user_one", 601), sourceId: source.id });
    await db.insert(schema.resourceGrant).values([
      {
        id: "grant_installation",
        organizationId: org,
        userId: "member_one",
        resourceType: "github_installation",
        resourceId: "ACME",
        permissionsJson: '["read"]',
      },
      {
        id: "grant_repository",
        organizationId: org,
        userId: "member_one",
        resourceType: "github_repository",
        resourceId: "Acme/site",
        permissionsJson: '["read"]',
      },
    ]);

    await repo.removeSourceAndRebind(org, source.id);

    await expect(
      db.query.resourceGrant.findMany({
        where: (table, { eq }) => eq(table.organizationId, org),
      }),
    ).resolves.toEqual([]);
  });
});
