import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDatabase, type DatabaseConnection } from "../connection";
import { createEncryption } from "../encryption";
import { createRepositories, type Repositories } from "./factory";
import { withProjectConfigurationWrite } from "./project-work-admission";
import * as schema from "../schema";

// Point only at a disposable test database. The default runs the same repository
// contract on PGlite; PostgreSQL additionally verifies separate-connection waits.
const postgresUrl = process.env.OPENSHIP_ADMISSION_TEST_DATABASE_URL;
const encryption = createEncryption("project-promotion-admission-test");
let connection: DatabaseConnection;
let repos: Repositories;
let orgId: string;
let rows: Awaited<ReturnType<typeof seed>>;

beforeAll(async () => {
  connection = await createDatabase(
    postgresUrl ? { driver: "pg", url: postgresUrl } : { driver: "pglite", dataDir: "memory://" },
  );
  repos = createRepositories(connection.db, encryption);
}, 30_000);
afterAll(async () => {
  await connection?.close();
  encryption.close();
});
beforeEach(async () => {
  rows = await seed();
});
afterEach(async () => {
  await connection.db.delete(schema.organization).where(eq(schema.organization.id, orgId));
});

async function seed() {
  orgId = randomUUID();
  await connection.db
    .insert(schema.organization)
    .values({ id: orgId, name: "Test", slug: orgId, createdAt: new Date() });
  const group = await repos.projectGroup.create({
    organizationId: orgId,
    name: "App",
    slug: "app",
  });
  const project = await repos.project.create({
    organizationId: orgId,
    groupId: group.id,
    name: "App",
    slug: "app",
    gitProvider: "github",
    gitOwner: "owner",
    gitRepo: "app",
    cloudPromotion: {
      id: randomUUID(),
      target: {
        apiUrl: "https://api.openship.io",
        userId: "cloud-user",
        organizationId: "cloud-org",
      },
      sourceDigest: "a".repeat(64),
      imported: { project: 1 },
    },
  });
  const sibling = await repos.project.create({
    organizationId: orgId,
    groupId: group.id,
    name: "Preview",
    slug: "preview",
    environmentSlug: "preview",
  });
  const service = await repos.service.create({
    projectId: project.id,
    name: "api",
    image: "node:22",
  });
  const siblingService = await repos.service.create({
    projectId: sibling.id,
    name: "api",
    image: "node:22",
  });
  const secret = await repos.project.setEnvVar({
    projectId: project.id,
    key: "SECRET",
    value: "original",
    environment: "production",
    isSecret: true,
  });
  const domain = await repos.domain.create({
    projectId: project.id,
    serviceId: service.id,
    hostname: `${orgId}.example.test`,
  });
  const rule = await repos.routeRule.create({
    projectId: project.id,
    organizationId: orgId,
    domainId: domain.id,
  });
  const webhook = await repos.incomingWebhook.create({
    projectId: project.id,
    organizationId: orgId,
    name: "Deploy",
    actionType: "deploy",
  });
  const deployment = await repos.deployment.create({
    projectId: project.id,
    organizationId: orgId,
    branch: "main",
    status: "ready",
  });
  return {
    group,
    project,
    sibling,
    service,
    siblingService,
    secret,
    domain,
    rule,
    webhook,
    deployment: deployment!,
  };
}

function snapshot() {
  const tables = [
    schema.projectGroup,
    schema.project,
    schema.service,
    schema.envVar,
    schema.domain,
    schema.routeRule,
    schema.incomingWebhook,
    schema.deployment,
  ];
  return Promise.all(tables.map((table) => connection.db.select().from(table).orderBy(table.id)));
}

const writes: Array<[string, () => Promise<unknown>]> = [
  ["project settings", () => repos.project.update(rows.project.id, { buildCommand: "new build" })],
  [
    "shared environment settings",
    () => repos.project.updateByApp(rows.group.id, { buildCommand: "new build" }),
  ],
  [
    "shared source identity",
    () =>
      repos.project.updateSourceByApp(
        rows.group.id,
        { gitOwner: "new-owner" },
        { gitOwner: "new-owner" },
      ),
  ],
  ["GitHub installation rebind", () => repos.project.rebindGitHubInstallation(orgId, "owner", 42)],
  ["group settings", () => repos.projectGroup.update(rows.group.id, { name: "New name" })],
  ["project soft deletion", () => repos.project.softDelete(rows.project.id)],
  ["group soft deletion", () => repos.projectGroup.softDelete(rows.group.id)],
  [
    "new project secret",
    () =>
      repos.project.setEnvVar({
        projectId: rows.project.id,
        key: "NEW",
        value: "new",
        environment: "production",
      }),
  ],
  ["secret update", () => repos.project.updateEnvVar(rows.secret.id, "new")],
  ["secret deletion", () => repos.project.deleteEnvVar(rows.secret.id)],
  [
    "environment replacement",
    () => repos.project.bulkSetEnvVars(rows.project.id, "production", []),
  ],
  [
    "project environment merge",
    () =>
      repos.project.mergeEnvVars(
        rows.project.id,
        "production",
        [{ key: "SECRET", value: "new" }],
        [],
      ),
  ],
  [
    "service environment merge",
    () =>
      repos.project.mergeEnvVars(
        rows.project.id,
        "production",
        [{ key: "NEW", value: "new" }],
        [],
        rows.service.id,
      ),
  ],
  [
    "service create",
    () =>
      repos.service.create({ projectId: rows.project.id, name: "new-service", image: "node:22" }),
  ],
  ["service settings", () => repos.service.update(rows.service.id, { image: "node:24" })],
  [
    "service move into a protected project",
    () => repos.service.update(rows.siblingService.id, { projectId: rows.project.id }),
  ],
  ["service removal", () => repos.service.remove(rows.service.id)],
  ["bulk service removal", () => repos.service.deleteByProjectId(rows.project.id)],
  [
    "domain create",
    () =>
      repos.domain.create({ projectId: rows.project.id, hostname: `new-${orgId}.example.test` }),
  ],
  ["domain settings", () => repos.domain.update(rows.domain.id, { externalIngress: true })],
  ["primary domain", () => repos.domain.setPrimary(rows.project.id, rows.domain.id)],
  [
    "certificate settings",
    () => repos.domain.updateSsl(rows.domain.id, { sslStatus: "active", manualSsl: true }),
  ],
  ["domain removal", () => repos.domain.remove(rows.domain.id)],
  [
    "domain and service routing removal",
    () =>
      repos.domain.removeWithServiceRouting(rows.domain.id, {
        serviceId: rows.service.id,
        routing: { exposed: false },
      }),
  ],
  ["bulk domain removal", () => repos.domain.deleteByProjectId(rows.project.id)],
  ["service domain removal", () => repos.domain.deleteByServiceId(rows.service.id)],
  [
    "route rule create",
    () => repos.routeRule.create({ projectId: rows.project.id, organizationId: orgId }),
  ],
  ["route rule update", () => repos.routeRule.update(rows.rule.id, { enabled: false })],
  ["route rule removal", () => repos.routeRule.removeForProject(rows.project.id, rows.rule.id)],
  [
    "webhook create",
    () =>
      repos.incomingWebhook.create({
        projectId: rows.project.id,
        organizationId: orgId,
        name: "New",
        actionType: "deploy",
      }),
  ],
  ["webhook update", () => repos.incomingWebhook.update(rows.webhook.id, { enabled: false })],
  [
    "webhook credential update",
    () => repos.incomingWebhook.updateIfUnchanged(rows.webhook, { tokenEncrypted: "new" }),
  ],
  [
    "webhook removal",
    () => repos.incomingWebhook.removeForProject(rows.project.id, rows.webhook.id),
  ],
  ["deployment pin", () => repos.deployment.setPinned(rows.deployment.id, true)],
  ["deployment removal", () => repos.deployment.deleteDeployment(rows.deployment.id)],
];

describe("project promotion configuration admission", () => {
  it.each(writes)(
    "refuses %s after the cleanup claim without partial writes",
    async (_name, write) => {
      await repos.project.claimDeletion(rows.project.id, { protectConfiguration: true });
      const before = await snapshot();
      await expect(write()).rejects.toMatchObject({
        statusCode: 409,
        code: "PROJECT_TRANSFER_IN_PROGRESS",
      });
      expect(await snapshot()).toEqual(before);
    },
  );

  it("keeps unrelated projects writable and releases the fence after a failed cleanup", async () => {
    await repos.project.claimDeletion(rows.project.id, { protectConfiguration: true });
    await repos.project.update(rows.sibling.id, { buildCommand: "preview build" });
    await repos.project.clearDeletionInProgress(rows.project.id);
    await repos.project.update(rows.project.id, { buildCommand: "new build" });
    expect(await repos.project.findById(rows.project.id)).toMatchObject({
      buildCommand: "new build",
      deletionInProgress: false,
    });
    expect(
      (await repos.project.findById(rows.project.id))?.cloudPromotion?.cleanupInProgress,
    ).toBeUndefined();
    expect((await repos.project.findById(rows.sibling.id))?.buildCommand).toBe("preview build");
  });

  it("does not fence ordinary deletion workers or the receipt on the Cloud copy", async () => {
    await repos.project.update(rows.project.id, { buildCommand: "cloud edit" });
    await repos.project.claimDeletion(rows.project.id);
    await repos.project.update(rows.project.id, { disabledAt: new Date() });
    expect((await repos.project.findById(rows.project.id))?.disabledAt).toBeInstanceOf(Date);
  });

  it.each(writes)(
    "refuses %s once workers are quiescent, before any cleanup failure exists",
    async (_name, write) => {
      await repos.project.claimDeletion(rows.project.id);
      expect(await repos.project.beginDeletionCleanup(rows.project.id)).toBe(true);
      const before = await snapshot();
      await expect(write()).rejects.toMatchObject({ code: "PROJECT_DELETION_PENDING" });
      expect(await snapshot()).toEqual(before);
    },
  );

  it("refuses a protected claim without a promotion receipt", async () => {
    expect(await repos.project.claimDeletion(rows.sibling.id, { protectConfiguration: true })).toBe(
      false,
    );
    expect((await repos.project.findById(rows.sibling.id))?.deletionInProgress).toBe(false);
  });

  it("protects the shared Git source even when a legacy environment has different source metadata", async () => {
    await repos.project.update(rows.project.id, { gitProvider: "local", gitOwner: null });
    await repos.projectGroup.update(rows.group.id, { gitProvider: "github", gitOwner: "owner" });
    await repos.project.claimDeletion(rows.project.id, { protectConfiguration: true });
    const before = await snapshot();
    await expect(repos.project.rebindGitHubInstallation(orgId, "owner", 42)).rejects.toMatchObject({
      code: "PROJECT_TRANSFER_IN_PROGRESS",
    });
    expect(await snapshot()).toEqual(before);
  });
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitForBlockedConnection() {
  await expect
    .poll(
      async () => {
        const result = await connection.pool!.query(
          "select count(*)::int as count from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and pid <> pg_backend_pid()",
        );
        return result.rows[0].count;
      },
      { timeout: 5000 },
    )
    .toBeGreaterThan(0);
}

describe.skipIf(!postgresUrl)("PostgreSQL promotion admission across connections", () => {
  it("waits for an earlier edit to commit before claiming the source", async () => {
    const entered = deferred();
    const release = deferred();
    const edit = withProjectConfigurationWrite(
      connection.db,
      eq(schema.project.id, rows.project.id),
      async (tx) => {
        await tx
          .update(schema.project)
          .set({ buildCommand: "accepted edit" })
          .where(eq(schema.project.id, rows.project.id));
        entered.resolve();
        await release.promise;
      },
    );
    await entered.promise;
    const claim = repos.project.claimDeletion(rows.project.id, { protectConfiguration: true });
    try {
      await waitForBlockedConnection();
    } finally {
      release.resolve();
    }
    await edit;
    expect(await claim).toBe(true);
    expect((await repos.project.findById(rows.project.id))?.buildCommand).toBe("accepted edit");
  });

  it.each([writes[0], writes[2], writes[11], writes[14]])(
    "refuses a waiting %s after a concurrent claim commits",
    async (_name, write) => {
      const entered = deferred();
      const release = deferred();
      const claim = connection.db.transaction(async (tx) => {
        await createRepositories(tx, encryption).project.claimDeletion(rows.project.id, {
          protectConfiguration: true,
        });
        entered.resolve();
        await release.promise;
      });
      await entered.promise;
      const edit = write().then(
        () => null,
        (error: unknown) => error,
      );
      try {
        await waitForBlockedConnection();
      } finally {
        release.resolve();
      }
      await claim;
      const before = await snapshot();
      expect(await edit).toMatchObject({ code: "PROJECT_TRANSFER_IN_PROGRESS" });
      expect(await snapshot()).toEqual(before);
    },
  );
});

it("keeps partial deletion closed to new work, while allowing a locked cleanup retry", async () => {
  const id = rows.project.id;
  await repos.project.claimDeletion(id);
  await repos.project.markDeletionFailed(id, "Cache cleanup interrupted");
  expect(await repos.project.findById(id)).toMatchObject({
    deletionInProgress: true,
    lifecycleOperation: { kind: "delete", status: "failed", error: "Cache cleanup interrupted" },
  });
  await expect(
    repos.service.create({ projectId: id, name: "new", image: "node:22" }),
  ).rejects.toThrow(/delet/i);
  await expect(
    repos.deployment.create({
      projectId: id,
      organizationId: orgId,
      branch: "main",
      status: "queued",
    }),
  ).resolves.toBeUndefined();
  expect(await repos.project.claimDeletion(id)).toBe(true);
  expect(await repos.project.findById(id)).toMatchObject({
    deletionInProgress: true,
    lifecycleOperation: { kind: "delete", status: "failed", error: "Cache cleanup interrupted" },
  });
  await expect(
    repos.service.create({ projectId: id, name: "during-retry", image: "node:22" }),
  ).rejects.toMatchObject({ code: "PROJECT_DELETION_PENDING" });
  expect(await repos.project.beginDeletionCleanup(id)).toBe(true);
  expect(await repos.project.findById(id)).toMatchObject({
    lifecycleOperation: { kind: "delete", status: "running" },
  });
  await expect(
    repos.project.update(id, { buildCommand: "edit during cleanup" }),
  ).rejects.toMatchObject({ code: "PROJECT_DELETION_PENDING" });
  await repos.project.deleteHard(id);
  expect(await repos.project.findById(id)).toBeUndefined();
});
