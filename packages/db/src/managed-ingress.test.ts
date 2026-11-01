import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDatabase } from "./connection";
import { createDomainRepo } from "./repos/domain.repo";
import { createIngressRepo } from "./repos/ingress.repo";
import * as s from "./schema";
import { createTransferReader, selectProjectTransfer } from "./project-transfer";
let connection: Awaited<ReturnType<typeof createDatabase>>;
let domains: ReturnType<typeof createDomainRepo>, ingress: ReturnType<typeof createIngressRepo>;
beforeAll(async () => {
  connection = await createDatabase({ driver: "pglite", dataDir: "memory://" });
  const db = connection.db;
  domains = createDomainRepo(db);
  ingress = createIngressRepo(db);
  await db.insert(s.organization).values([
    { id: "org", name: "One" },
    { id: "other", name: "Other" },
  ]);
  await db.insert(s.servers).values([
    { id: "server", organizationId: "org", name: "Server", sshHost: "192.0.2.1" },
    { id: "manual", organizationId: "org", name: "Manual", sshHost: "192.0.2.2" },
    { id: "foreign", organizationId: "other", sshHost: "192.0.2.3" },
  ]);
  await db.insert(s.credential).values({
    id: "credential",
    organizationId: "org",
    provider: "cloudflare",
    name: "Cloudflare",
    secretsEnc: "enc1:fake",
  });
  await db.insert(s.projectGroup).values([
    { id: "group", organizationId: "org", name: "App", slug: "app" },
    { id: "foreign-group", organizationId: "other", name: "Other", slug: "other" },
  ]);
  await db.insert(s.project).values([
    {
      id: "project",
      groupId: "group",
      organizationId: "org",
      serverId: "server",
      name: "App",
      slug: "app",
    },
    {
      id: "manual-project",
      environmentSlug: "manual",
      groupId: "group",
      organizationId: "org",
      serverId: "manual",
      name: "Manual",
      slug: "manual",
    },
    {
      id: "foreign-project",
      groupId: "foreign-group",
      organizationId: "other",
      serverId: "foreign",
      name: "Other",
      slug: "other",
    },
  ]);
  await ingress.create({
    id: "connection",
    organizationId: "org",
    serverId: "server",
    credentialId: "credential",
    accountId: "account",
    tunnelId: "tunnel",
    name: "Tunnel",
    connector: "existing",
    defaultForDomains: true,
    defaultAccessPolicyId: "policy",
    status: "ready",
  });
}, 30_000);
afterAll(async () => connection?.close());
describe("managed ingress durable lifecycle", () => {
  it("enrolls every new custom hostname atomically and skips ACME before its first deploy", async () => {
    const row = await domains.create({
      projectId: "project",
      hostname: "app.example.test",
      domainType: "custom",
    });
    expect(row.externalIngress).toBe(true);
    expect(await ingress.forDomain(row.id)).toMatchObject({
      connectionId: "connection",
      hostname: row.hostname,
      accessPolicyId: "policy",
      status: "pending",
    });
    expect(
      (
        await domains.findOrCreate({
          projectId: "project",
          hostname: row.hostname,
          domainType: "custom",
        })
      ).id,
    ).toBe(row.id);
    expect((await ingress.hosts("connection")).filter((h) => h.domainId === row.id)).toHaveLength(
      1,
    );
  });
  it("does not alter managed/free or unbound manual external-ingress domains", async () => {
    const free = await domains.create({
      projectId: "project",
      hostname: "app.opsh.io",
      domainType: "free",
    });
    const manual = await domains.create({
      projectId: "manual-project",
      hostname: "manual.example.test",
      domainType: "custom",
      externalIngress: true,
    });
    expect(free.externalIngress).toBe(false);
    expect(manual.externalIngress).toBe(true);
    expect(await ingress.forDomain(free.id)).toBeUndefined();
    expect(await ingress.forDomain(manual.id)).toBeUndefined();
  });
  it("rejects binding another organization's or server's domain", async () => {
    const foreign = await domains.create({
      projectId: "foreign-project",
      hostname: "foreign.example.test",
      domainType: "custom",
    });
    const manual = await domains.create({
      projectId: "manual-project",
      hostname: "wrong.example.test",
      domainType: "custom",
    });
    for (const d of [foreign, manual])
      await expect(ingress.bindDomain(d.id, "connection", null)).rejects.toThrow(
        /deployment server/,
      );
    expect((await domains.findById(foreign.id))?.externalIngress).toBe(false);
  });
  it("retains provider ownership as a tombstone after deleting a domain or project", async () => {
    const row = await domains.create({
      projectId: "project",
      hostname: "remove.example.test",
      domainType: "custom",
    });
    const host = (await ingress.forDomain(row.id))!;
    await ingress.updateHost(host.id, {
      ownership: { zoneId: "zone", dnsId: "record", appId: "application" },
      status: "ready",
    });
    await domains.remove(row.id);
    expect(await ingress.host(host.id)).toMatchObject({
      domainId: null,
      hostname: row.hostname,
      ownership: { dnsId: "record", appId: "application" },
    });
    expect((await ingress.due()).some(({ host: h }) => h.id === host.id)).toBe(true);
  });
  it("keeps the credential and server while provider cleanup needs them", async () => {
    await expect(
      connection.db.delete(s.credential).where(eq(s.credential.id, "credential")),
    ).rejects.toThrow();
    await expect(
      connection.db.delete(s.servers).where(eq(s.servers.id, "server")),
    ).rejects.toThrow();
  });
  it("turns off enrollment before removing a connection without changing existing bindings", async () => {
    await ingress.update("connection", { defaultForDomains: false, status: "removing" });
    const row = await domains.create({
      projectId: "project",
      hostname: "later.example.test",
      domainType: "custom",
    });
    expect(row.externalIngress).toBe(false);
    expect(await ingress.forDomain(row.id)).toBeUndefined();
    expect((await ingress.hosts("connection")).length).toBeGreaterThan(0);
  });
});

it("blocks a project export through its real domain-to-hostname foreign keys", async () => {
  await expect(
    selectProjectTransfer(createTransferReader(connection.db), {
      scope: "projects",
      projectIds: ["project"],
      history: [],
      includeEnvironments: false,
      includeLinkedProjects: false,
      includeIntegrations: false,
    }),
  ).rejects.toMatchObject({
    statusCode: 409,
    message: expect.stringContaining("Disconnect managed Cloudflare hostnames"),
  });
});

it("prioritizes newly queued setup over old periodic drift checks", async () => {
  await ingress.update("connection", { status: "ready", defaultForDomains: true });
  const drift = await domains.create({
    projectId: "project",
    hostname: "drift-queue.example.test",
    domainType: "custom",
  });
  const setup = await domains.create({
    projectId: "project",
    hostname: "fresh-queue.example.test",
    domainType: "custom",
  });
  const driftHost = (await ingress.forDomain(drift.id))!,
    setupHost = (await ingress.forDomain(setup.id))!;
  // Remove earlier fixture work so this is a queue-ordering regression.
  for (const host of await ingress.hosts("connection"))
    if (host.id !== driftHost.id && host.id !== setupHost.id)
      await ingress.updateHost(host.id, {
        status: "error",
        nextAttemptAt: new Date(Date.now() + 60_000),
      });
  await ingress.updateHost(driftHost.id, { status: "ready", nextAttemptAt: new Date(0) });
  expect((await ingress.due(1))[0]?.host.id).toBe(setupHost.id);
});
