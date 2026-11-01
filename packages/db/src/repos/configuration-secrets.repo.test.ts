import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDatabase, createRepositories, schema, type DatabaseConnection } from "../factory";
import { createEncryption } from "../encryption";
import {
  CONFIGURATION_PREFIX,
  createConfigurationSecrets,
  SERVICE_SECRET_FIELDS,
} from "../configuration-secrets";
import { toComposeSpec } from "./service.repo";

describe("service configuration at rest (GH-844)", () => {
  const encryption = createEncryption("configuration-test-installation-a");
  const otherEncryption = createEncryption("configuration-test-installation-b");
  const codec = createConfigurationSecrets(encryption);
  let connection: DatabaseConnection;
  let repos: ReturnType<typeof createRepositories>;
  let sequence = 0;
  beforeAll(async () => {
    connection = await createDatabase({ driver: "pglite", dataDir: "memory://" });
    repos = createRepositories(connection.db, encryption);
    await connection.db.insert(schema.organization).values({ id: "org", name: "Test" });
  });
  afterAll(async () => {
    await connection?.close();
    encryption.close();
    otherEncryption.close();
  });
  async function project() {
    const slug = `app-${++sequence}`;
    const group = await repos.projectGroup.create({ organizationId: "org", name: slug, slug });
    return repos.project.create({ groupId: group.id, organizationId: "org", name: slug, slug });
  }
  const config = {
    environment: {
      PASSWORD: "inline-secret-844",
      LITERAL: `${CONFIGURATION_PREFIX}literal-user-value`,
    },
    buildArgs: { TOKEN: "build-secret-844", INHERIT: null, EMPTY: "" },
    advanced: { files: [{ path: "/run/config", content: "mounted-secret-844" }] },
  };
  async function storedService(id: string) {
    return connection.db.query.service.findFirst({ where: eq(schema.service.id, id) });
  }

  it("seals live config and both drift baselines while every repository read returns usable values", async () => {
    const app = await project();
    const baseline = toComposeSpec(config);
    const created = await repos.service.create({
      projectId: app.id,
      name: "web",
      ...config,
      importedSpec: baseline,
      driftSpec: baseline,
    });
    expect(created).toMatchObject(config);
    const stored = await storedService(created.id);
    for (const field of SERVICE_SECRET_FIELDS)
      expect(stored![field]).toEqual(expect.stringMatching(/^openship:config:v1:/));
    for (const secret of ["inline-secret-844", "build-secret-844", "mounted-secret-844"])
      expect(JSON.stringify(stored)).not.toContain(secret);
    const reads = [
      await repos.service.findById(created.id),
      await repos.service.findByName(app.id, "web"),
      ...(await repos.service.listByProject(app.id)),
      ...(await repos.service.listByProjectKind(app.id, "compose")),
      ...(await repos.service.listByProjects([app.id])).get(app.id)!,
    ];
    for (const read of reads)
      expect(read).toMatchObject({ ...config, importedSpec: baseline, driftSpec: baseline });
    await repos.service.update(created.id, { environment: { PASSWORD: "rotated-844" } });
    expect((await repos.service.findById(created.id))?.environment).toEqual({
      PASSWORD: "rotated-844",
    });
    expect((await repos.service.findById(created.id))?.buildArgs).toEqual(config.buildArgs);
    expect(JSON.stringify(await storedService(created.id))).not.toContain("rotated-844");
  });

  it("compares decrypted baselines when Compose changes and preserves the original frozen release", async () => {
    const app = await project();
    await repos.service.syncFromCompose(app.id, [{ name: "web", image: "app:1", ...config }], {
      composeAuthoritative: true,
    });
    const before = (await repos.service.listByProject(app.id))[0]!;
    const release = await repos.deployment.create({
      projectId: app.id,
      organizationId: "org",
      branch: "main",
      status: "ready",
      meta: {
        serverId: "server-844",
        composeServices: [before],
        composeDeployment: { decision: "pending" },
      },
    });
    expect(release).toBeDefined();
    const updated = await repos.service.reconcileFromCompose(app.id, [
      {
        name: "web",
        image: "app:2",
        ...config,
        environment: { ...config.environment, PASSWORD: "new-repo-secret-844" },
      },
    ]);
    expect(updated.driftedNames).toEqual([]);
    expect((await repos.service.findById(before.id))?.environment?.PASSWORD).toBe(
      "new-repo-secret-844",
    );
    const stored = await connection.db.query.deployment.findFirst({
      where: eq(schema.deployment.id, release!.id),
    });
    expect(stored!.meta).toMatchObject({
      serverId: "server-844",
      composeServices: expect.stringMatching(/^openship:config:v1:/),
    });
    expect(JSON.stringify(stored!.meta)).not.toContain("inline-secret-844");
    const historical = { meta: { composeServices: [expect.objectContaining(config)] } };
    const reads = [
      await repos.deployment.findById(release!.id),
      await repos.deployment.findLatestReady(app.id, "production"),
      await repos.deployment.findLatestByProject(app.id),
      await repos.deployment.getLatestSuccessfulForBranch(app.id, "main"),
      ...(await repos.deployment.listByProject(app.id)).rows,
      ...(await repos.deployment.listReadyOrderedDesc(app.id)),
      (await repos.deployment.findManyById([release!.id])).get(release!.id),
      (await repos.deployment.findLatestByProjects([app.id])).get(app.id),
    ];
    for (const read of reads) expect(read).toMatchObject(historical);
    await repos.deployment.supersedePendingDecisions(app.id, "a-new-release");
    expect((await repos.deployment.findById(release!.id))?.meta).toMatchObject({
      composeDeployment: { decision: "superseded" },
      composeServices: [expect.objectContaining(config)],
    });
  });

  it("seals replacement deployment metadata without changing target identity or status rules", async () => {
    const app = await project();
    const dep = await repos.deployment.create({
      projectId: app.id,
      organizationId: "org",
      branch: "main",
      meta: { composeServices: [{ name: "web", ...config }] },
    });
    const meta = {
      serverId: "remote",
      composeServices: [{ name: "web", environment: { PASSWORD: "replacement-secret-844" } }],
    };
    expect(await repos.deployment.updateStatus(dep!.id, "building", { meta })).toBe(true);
    expect((await repos.deployment.listInFlightByProject(app.id))[0]?.meta).toEqual(meta);
    expect(
      await repos.deployment.findInProgressByReleaseVersion(app.id, undefined),
    ).toBeUndefined();
    expect(
      (await repos.deployment.listByStatus("building")).find((row) => row.id === dep!.id)?.meta,
    ).toEqual(meta);
    expect(
      (await repos.deployment.listByOrganization("org")).rows.find((row) => row.id === dep!.id)
        ?.meta,
    ).toEqual(meta);
    expect(await repos.deployment.cancelInFlight(dep!.id, { meta })).toBe(true);
    expect(await repos.deployment.updateStatus(dep!.id, "ready", { meta })).toBe(false);
    const raw = await connection.db.query.deployment.findFirst({
      where: eq(schema.deployment.id, dep!.id),
    });
    expect(JSON.stringify(raw!.meta)).not.toContain("replacement-secret-844");
    expect((await repos.deployment.findById(dep!.id))?.meta).toEqual(meta);
  });

  it("encrypts services created by atomic project cloning", async () => {
    const cloned = await repos.project.createProjectWithRecords({
      group: { organizationId: "org", name: "Cloned", slug: "cloned" },
      project: { organizationId: "org", name: "Cloned", slug: "cloned" },
      services: [{ sourceId: "source", row: { name: "web", ...config } }],
      envVars: [],
    });
    const id = cloned.serviceIdBySourceId.source!;
    expect(await repos.service.findById(id)).toMatchObject(config);
    expect(JSON.stringify(await storedService(id))).not.toContain("inline-secret-844");
  });

  it("backfills multiple pages of legacy rows, keeps timestamps and is idempotent", async () => {
    const app = await project();
    const baseline = toComposeSpec(config);
    await connection.db.insert(schema.service).values(
      Array.from({ length: 103 }, (_, i) => ({
        id: `legacy-${i}`,
        name: `legacy-${i}`,
        projectId: app.id,
        ...config,
        importedSpec: baseline,
        driftSpec: baseline,
      })),
    );
    await connection.db
      .insert(schema.deployment)
      .values({
        id: "legacy-release",
        projectId: app.id,
        organizationId: "org",
        branch: "main",
        status: "ready",
        meta: { serverId: "old-server", composeServices: [{ name: "web", ...config }] },
      });
    const original = await storedService("legacy-0");
    expect(await repos.service.findById("legacy-0")).toMatchObject(config);
    expect(await repos.configurationSecrets.backfillLegacy()).toEqual({
      services: 103,
      deployments: 1,
    });
    const sealed = await storedService("legacy-0");
    expect(sealed!.updatedAt).toEqual(original!.updatedAt);
    expect(JSON.stringify(sealed)).not.toContain("inline-secret-844");
    expect(await repos.service.findById("legacy-102")).toMatchObject(config);
    expect((await repos.deployment.findById("legacy-release"))?.meta).toMatchObject({
      serverId: "old-server",
      composeServices: [expect.objectContaining(config)],
    });
    expect(await repos.configurationSecrets.backfillLegacy()).toEqual({
      services: 0,
      deployments: 0,
    });
    expect((await storedService("legacy-0"))!.environment).toBe(sealed!.environment);
  });

  it("fails closed on a wrong key or damaged ciphertext without altering saved values", async () => {
    const app = await project();
    const service = await repos.service.create({ projectId: app.id, name: "web", ...config });
    const wrongRepos = createRepositories(connection.db, otherEncryption);
    await expect(wrongRepos.service.findById(service.id)).rejects.toThrow(
      "Unable to decrypt stored configuration",
    );
    const raw = await storedService(service.id);
    const broken = String(raw!.environment).slice(0, -8) + "tampered";
    await connection.db
      .update(schema.service)
      .set({ environment: broken as never })
      .where(eq(schema.service.id, service.id));
    await expect(repos.service.findById(service.id)).rejects.toThrow(
      "Unable to decrypt stored configuration",
    );
    expect((await storedService(service.id))!.environment).toBe(broken);
  });

  it("never accepts a public string as trusted ciphertext and preserves empty defaults", () => {
    const sealed = codec.sealJson(config.environment);
    expect(() => codec.sealJson(sealed)).toThrow("Expected JSON configuration");
    expect(codec.openJson(sealed)).toEqual(config.environment);
    for (const value of [undefined, null, {}, []])
      expect(codec.openJson(codec.sealJson(value))).toEqual(value);
    expect(() => codec.openJson("openship:config:v99:unknown")).toThrow("Unable to decrypt");
  });
});
