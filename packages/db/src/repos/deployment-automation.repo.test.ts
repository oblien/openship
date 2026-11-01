import { beforeAll, beforeEach, afterAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq, sql } from "drizzle-orm";
import { fileURLToPath } from "node:url";
import * as schema from "../schema";
import { createEncryption } from "../encryption";
import { createProjectRepo } from "./project.repo";
import { createPullRequestPreviewRepo } from "./pull-request-preview.repo";
import { createDeploymentRepo } from "./deployment.repo";

const client = new PGlite("memory://");
const db = drizzle(client, { schema });
const encryption = createEncryption("deployment-automation-test");
const projects = createProjectRepo(db, encryption);
const previews = createPullRequestPreviewRepo(db, encryption);
const deployments = createDeploymentRepo(db, encryption);
beforeAll(async () => {
  await migrate(db, { migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)) });
  await client.exec("SET session_replication_role = replica");
}, 30_000);
afterAll(async () => {
  await client.close();
  encryption.close();
});
beforeEach(async () => {
  await client.exec("TRUNCATE pull_request_preview, env_var, service, deployment, project CASCADE");
  await db.insert(schema.project).values({
    id: "p",
    organizationId: "org",
    groupId: "g",
    name: "App",
    slug: "app",
    framework: "nextjs",
    packageManager: "bun",
    rootDirectory: "apps/web",
    runtimeMode: "docker",
    buildCommand: "PUBLIC_URL='https://example.test' bun run build",
    previewSettings: { enabled: true, comments: true },
    volumes: ["bun:/root/.bun/install/cache", "next:/app/.next/cache", "data:/app/data"],
  });
  await db.insert(schema.service).values({
    id: "s",
    projectId: "p",
    name: "web",
    kind: "monorepo",
    buildCommand: "TOKEN=service-secret bun run build",
  });
});

describe("command variables", () => {
  it("encrypts variables and removes assignments atomically", async () => {
    const result = await projects.migrateCommandEnvironment("p", "org", {
      environment: "production",
      commands: { buildCommand: "PUBLIC_URL='https://example.test' bun run build" },
    });
    expect(result).toEqual({ keys: ["PUBLIC_URL"], commands: { buildCommand: "bun run build" } });
    expect((await projects.findById("p"))?.buildCommand).toBe("bun run build");
    const [stored] = await projects.listEnvVars("p", "production", null);
    expect(stored!.value).not.toContain("example.test");
    expect(encryption.decrypt(stored!.value)).toBe("https://example.test");
    expect(stored!.isSecret).toBe(true);
  });
  it("rolls back conflicting values, stale edits, and cross-org service writes", async () => {
    await projects.mergeEnvVars(
      "p",
      "production",
      [{ key: "PUBLIC_URL", value: encryption.encrypt("different") }],
      [],
    );
    await expect(
      projects.migrateCommandEnvironment("p", "org", {
        environment: "production",
        commands: { buildCommand: "PUBLIC_URL='https://example.test' bun run build" },
      }),
    ).rejects.toThrow("different value");
    expect((await projects.findById("p"))?.buildCommand).toContain("PUBLIC_URL=");
    await expect(
      projects.migrateCommandEnvironment("p", "org", {
        environment: "production",
        commands: { buildCommand: "PUBLIC_URL=old bun run build" },
      }),
    ).rejects.toThrow("Commands changed");
    await expect(
      projects.migrateCommandEnvironment("p", "other-org", {
        environment: "production",
        serviceId: "s",
        commands: { buildCommand: "TOKEN=service-secret bun run build" },
      }),
    ).rejects.toThrow("unavailable");
    expect(await projects.listEnvVars("p", "production", "s")).toHaveLength(0);
  });
  it("keeps service variables scoped and reuses identical existing values", async () => {
    await projects.mergeEnvVars(
      "p",
      "production",
      [{ key: "TOKEN", value: encryption.encrypt("service-secret"), isSecret: true }],
      [],
      "s",
    );
    const [before] = await projects.listEnvVars("p", "production", "s");
    await projects.migrateCommandEnvironment("p", "org", {
      environment: "production",
      serviceId: "s",
      commands: { buildCommand: "TOKEN=service-secret bun run build" },
    });
    expect(await projects.listEnvVars("p", "production", "s")).toEqual([before]);
    expect(await projects.listEnvVars("p", "production", null)).toHaveLength(0);
  });
});

describe("cache migration", () => {
  it("retains manual mounts until a managed-cache deployment succeeds, then removes only selected mounts", async () => {
    expect((await projects.buildCacheMigration("p", "org")).canMigrate).toBe(false);
    await expect(
      projects.buildCacheMigration("p", "org", undefined, ["next:/app/.next/cache"]),
    ).rejects.toThrow("Deploy successfully");
    await db
      .insert(schema.deployment)
      .values({ id: "d", projectId: "p", organizationId: "org", branch: "main", status: "failed" });
    await projects.recordBuildCacheReceipt("p", "p", {
      targets: ["/root/.bun/install/cache", "/workspace/apps/web/.next/cache"],
      deploymentId: "d",
      completedAt: new Date().toISOString(),
    });
    expect((await projects.buildCacheMigration("p", "org")).canMigrate).toBe(false);
    await db
      .update(schema.deployment)
      .set({ status: "ready" })
      .where(eq(schema.deployment.id, "d"));
    expect((await projects.buildCacheMigration("p", "org")).canMigrate).toBe(true);
    await projects.buildCacheMigration("p", "org", undefined, ["next:/app/.next/cache"]);
    expect((await projects.findById("p"))!.volumes).toEqual([
      "bun:/root/.bun/install/cache",
      "data:/app/data",
    ]);
    await expect(
      projects.buildCacheMigration("p", "org", undefined, ["data:/app/data"]),
    ).rejects.toThrow("Deploy successfully");
  });
});

describe("durable preview identity", () => {
  const enqueue = () =>
    previews.enqueue({
      organizationId: "org",
      sourceProjectId: "p",
      owner: "acme",
      repo: "app",
      number: 42,
    });
  it("keeps repository identity when a source changes repositories and PR numbers repeat", async () => {
    await enqueue();
    await previews.enqueue({
      organizationId: "org",
      sourceProjectId: "p",
      owner: "Acme",
      repo: "Other",
      number: 42,
    });
    await previews.enqueue({
      organizationId: "org",
      sourceProjectId: "p",
      owner: "acme",
      repo: "other",
      number: 42,
    });
    expect((await previews.list("p", "org")).map((row) => row.repo).sort()).toEqual([
      "app",
      "other",
    ]);
  });
  it("deduplicates deliveries, leases work and creates one isolated environment with only preview variables", async () => {
    await projects.mergeEnvVars(
      "p",
      "production",
      [{ key: "TOKEN", value: encryption.encrypt("production-secret") }],
      [],
    );
    await projects.mergeEnvVars(
      "p",
      "preview",
      [{ key: "TOKEN", value: encryption.encrypt("preview-secret") }],
      [],
    );
    await projects.mergeEnvVars(
      "p",
      "preview",
      [{ key: "SERVICE_TOKEN", value: encryption.encrypt("preview-service") }],
      [],
      "s",
    );
    await enqueue();
    await enqueue();
    const [intent] = await previews.due();
    expect(await previews.due()).toHaveLength(1);
    expect(await previews.claim(intent!.id, "one")).toBeTruthy();
    expect(await previews.claim(intent!.id, "two")).toBeUndefined();
    const input = {
      project: {
        organizationId: "org",
        groupId: "g",
        name: "PR",
        slug: "pr-42",
        environmentSlug: "pr-42",
        environmentType: "preview",
      },
      services: [{ sourceId: "s", row: { name: "web", kind: "monorepo" } }],
    };
    const child = await previews.createEnvironment(intent!.id, "one", input);
    expect((await previews.createEnvironment(intent!.id, "one", input)).id).toBe(child.id);
    const values = await projects.listEnvVars(child.id);
    expect(values.map((row) => encryption.decrypt(row.value)).sort()).toEqual([
      "preview-secret",
      "preview-service",
    ]);
    expect(values.every((row) => row.environment === "production")).toBe(true);
    expect(values.find((row) => row.key === "SERVICE_TOKEN")!.serviceId).not.toBe("s");
    expect(values.find((row) => row.key === "SERVICE_TOKEN")!.serviceId).toBeTruthy();
    await previews.release(intent!.id, "one");
    expect(await previews.claim(intent!.id, "two")).toBeTruthy();
  });
  it("rolls back environment creation on invalid service data", async () => {
    await enqueue();
    const [intent] = await previews.due();
    await previews.claim(intent!.id, "lease");
    await expect(
      previews.createEnvironment(intent!.id, "lease", {
        project: {
          organizationId: "org",
          groupId: "g",
          name: "PR",
          slug: "pr-42",
          environmentSlug: "pr-42",
        },
        services: [{ sourceId: "s", row: { name: null as unknown as string } }],
      }),
    ).rejects.toThrow();
    expect((await previews.list("p", "org"))[0]!.projectId).toBeNull();
    expect((await db.select().from(schema.project)).length).toBe(1);
  });
  it("commits preview admission, build session and SHA together, and fences expired workers", async () => {
    await enqueue();
    const [intent] = await previews.due();
    await previews.claim(intent!.id, "lease");
    const child = await previews.createEnvironment(intent!.id, "lease", {
      project: {
        organizationId: "org",
        groupId: "g",
        name: "PR",
        slug: "pr-42",
        environmentSlug: "pr-42",
        autoDeploy: false,
      },
      services: [],
    });
    const input = {
      projectId: child.id,
      organizationId: "org",
      branch: "feature",
      commitSha: "a".repeat(40),
      trigger: "webhook",
      status: "queued",
    };
    await expect(
      deployments.create(input, undefined, undefined, undefined, {
        id: intent!.id,
        token: "stale",
      }),
    ).rejects.toThrow("expired");
    expect(await db.select().from(schema.deployment)).toHaveLength(0);
    const admitted = await deployments.create(input, undefined, undefined, undefined, {
      id: intent!.id,
      token: "lease",
    });
    expect(admitted).toBeTruthy();
    expect((await previews.admittedDeployment(intent!.id, "lease", input.commitSha))?.id).toBe(
      admitted!.id,
    );
    expect((await deployments.findBuildSessionByDeploymentId(admitted!.id))?.status).toBe("queued");
    expect((await previews.list("p", "org"))[0]).toMatchObject({
      deploymentId: admitted!.id,
      headSha: input.commitSha,
    });
    await expect(
      deployments.create(input, undefined, undefined, undefined, {
        id: intent!.id,
        token: "lease",
      }),
    ).rejects.toThrow("already has");
    expect(await db.select().from(schema.deployment)).toHaveLength(1);
    // A ready deployment can still own an unfinished runtime handover. Preview
    // admission must retain the shared recovery gate before it queues new work.
    await db
      .update(schema.deployment)
      .set({
        status: "ready",
        roleHandover: sql`'{"phase":"published"}'::jsonb`,
      })
      .where(eq(schema.deployment.id, admitted!.id));
    await expect(
      deployments.create({ ...input, commitSha: "b".repeat(40) }, undefined, undefined, undefined, {
        id: intent!.id,
        token: "lease",
      }),
    ).rejects.toMatchObject({ code: "ROLE_HANDOVER_RECOVERY_PENDING" });
    expect((await previews.list("p", "org"))[0]!.headSha).toBe(input.commitSha);
  });
});
