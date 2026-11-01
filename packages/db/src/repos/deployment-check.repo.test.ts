import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { DEFAULT_GITHUB_DEPLOYMENT_CHECKS } from "@repo/core";
import * as schema from "../schema";
import { createEncryption } from "../encryption";
import { createDeploymentRepo } from "./deployment.repo";
import { createDeploymentCheckRepo, queueDeploymentChecks } from "./deployment-check.repo";

const client = new PGlite("memory://");
const db = drizzle(client, { schema });
const encryption = createEncryption("deployment-check-test-key");
const deployments = createDeploymentRepo(db, encryption);
const reports = createDeploymentCheckRepo(db);
const migrationsFolder = fileURLToPath(new URL("../../drizzle", import.meta.url));
beforeAll(async () => {
  await migrate(db, { migrationsFolder });
  await migrate(db, { migrationsFolder }); // The next boot is a no-op.
  await client.exec("SET session_replication_role = replica");
});
afterAll(async () => { await client.close(); encryption.close(); });
beforeEach(async () => {
  await client.exec('TRUNCATE deployment_check_run, deployment, build_session, service, project CASCADE');
  await db.insert(schema.project).values({ id: "project", organizationId: "org", groupId: "group", name: "App", slug: "app", gitOwner: "acme", gitRepo: "app" });
  await db.insert(schema.service).values([
    { id: "web", projectId: "project", name: "web", kind: "compose" },
    { id: "db", projectId: "project", name: "db", kind: "compose" },
  ]);
});
const create = (extra = {}) => deployments.create({ projectId: "project", organizationId: "org", branch: "main", commitSha: "a".repeat(40), ...extra });

describe("deployment Check outbox", () => {
  it("queues enabled-by-default reporting in the same admission as the deployment", async () => {
    const dep = (await create({ meta: { targetServiceIds: ["web"], composeServices: [{ name: "web" }, { name: "db" }], envVars: { TOKEN: "not-report-data" } } }))!;
    const [root] = await reports.list(dep.id);
    expect(root.source).toMatchObject({ owner: "acme", repo: "app", checks: DEFAULT_GITHUB_DEPLOYMENT_CHECKS,
      services: [{ name: "web", targeted: true }, { name: "db", targeted: false }] });
    expect(root.checkRunId).toBeNull();
    expect(JSON.stringify(root.source)).not.toContain("not-report-data");
    expect(await reports.due()).toEqual([{ id: root.id }]);
    expect(await create()).toBeUndefined();
    expect(await reports.due()).toHaveLength(1);
  });

  it("does not expect unrelated attached apps during a single-app deployment", async () => {
    const dep = (await create({ meta: { serviceDeploymentMode: "single", composeServices: [{ name: "old-service" }] } }))!;
    expect((await reports.list(dep.id))[0].source?.services).toEqual([]);
  });

  it("captures an explicit service deployment even on a single-app project", async () => {
    const dep = (await create({ meta: { serviceDeploymentMode: "single", targetServiceIds: ["db"] } }))!;
    expect((await reports.list(dep.id))[0].source?.services).toEqual([{ name: "db", targeted: true }]);
  });

  it("rolls back the reporting intent together with failed admission", async () => {
    await expect(db.transaction(async tx => {
      const [dep] = await tx.insert(schema.deployment).values({ id: "rollback", projectId: "project", organizationId: "org", branch: "main", status: "queued" }).returning();
      await queueDeploymentChecks(tx, dep);
      throw new Error("admission failed");
    })).rejects.toThrow("admission failed");
    expect(await reports.due()).toEqual([]);
    expect(await deployments.findById("rollback")).toBeUndefined();
  });

  it.each(["disabled", "local", "imported", "empty"])("does not publish %s work", async mode => {
    if (mode === "disabled" || mode === "empty") await db.update(schema.project).set({
      githubChecks: { ...DEFAULT_GITHUB_DEPLOYMENT_CHECKS, enabled: mode !== "disabled", ...(mode === "empty" && { deployment: false, services: [] }) },
    });
    if (mode === "local") await db.update(schema.project).set({ gitProvider: "local" });
    await create(mode === "imported" ? { status: "ready" } : {});
    expect(await reports.due()).toEqual([]);
  });

  it("captures source and preferences before a later project edit", async () => {
    await db.update(schema.project).set({ githubChecks: { ...DEFAULT_GITHUB_DEPLOYMENT_CHECKS, services: ["web"] } });
    const dep = (await create())!;
    await db.update(schema.project).set({ gitRepo: "other", githubChecks: { ...DEFAULT_GITHUB_DEPLOYMENT_CHECKS, enabled: false } });
    expect((await reports.list(dep.id))[0].source).toMatchObject({ repo: "app", checks: { enabled: true, services: ["web"] } });
  });

  it("resumes queued delivery after recreating the repository and scopes its visible errors", async () => {
    const dep = (await create())!;
    const [root] = await reports.list(dep.id);
    await reports.claim(root.id, "lease");
    await reports.release(root.id, "lease", { attempts: 1, lastError: "GitHub unavailable", nextAttemptAt: new Date(0) });
    const restarted = createDeploymentCheckRepo(db);
    expect(await restarted.due()).toEqual([{ id: root.id }]);
    expect(await restarted.latestForProject("project", "org")).toMatchObject({ error: "GitHub unavailable" });
    expect(await restarted.latestForProject("project", "another-org")).toBeNull();
  });

  it("claims once, renews ownership, and ignores a stale reporter after lease recovery", async () => {
    const dep = (await create())!;
    const [root] = await reports.list(dep.id);
    const claims = await Promise.all([reports.claim(root.id, "a"), reports.claim(root.id, "b")]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    const token = claims[0] ? "a" : "b";
    expect(await reports.renew(root.id, token)).toBe(true);
    expect(await reports.renew(root.id, "wrong")).toBe(false);
    await db.update(schema.deploymentCheckRun).set({ leaseExpiresAt: new Date(0) }).where(eq(schema.deploymentCheckRun.id, root.id));
    expect(await reports.claim(root.id, "recovery")).toBeDefined();
    expect(await reports.published(root.id, token, root.id, { checkRunId: 5, status: "completed", conclusion: "success", publishedDigest: "stale" })).toBe(false);
    await reports.release(root.id, token, { attempts: 0, lastError: null, nextAttemptAt: null });
    expect((await reports.list(dep.id))[0].leaseToken).toBe("recovery");
  });

  it("keeps one service mirror before its runtime row exists and preserves remote IDs", async () => {
    const dep = (await create())!;
    const [root] = await reports.list(dep.id);
    const first = await reports.ensureService(root, "web");
    const second = await reports.ensureService(root, "web");
    expect(first.id).toBe(second.id);
    await reports.claim(root.id, "lease");
    expect(await reports.published(root.id, "lease", first.id, { checkRunId: 15_000_000_001, status: "completed", conclusion: "failure", publishedDigest: "digest" })).toBe(true);
    expect((await reports.findByCheckRunId(15_000_000_001))?.id).toBe(first.id);
    expect(await reports.list(dep.id)).toHaveLength(2);
  });
});
