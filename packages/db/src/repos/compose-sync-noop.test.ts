import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createDatabase, createRepositories, schema, type DatabaseConnection } from "../factory";
import { createEncryption } from "../encryption";
import { toComposeSpec, type ParsedComposeService } from "./service.repo";

describe("Compose sync preserves unchanged services (#986)", () => {
  const encryption = createEncryption("compose-sync-986-test");
  const unchangedAt = new Date("2026-01-01T00:00:00.000Z");
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
  });

  const database: ParsedComposeService = {
    name: "db",
    image: "postgres:16-alpine",
    ports: ["5432"],
    environment: { POSTGRES_USER: "app", POSTGRES_PASSWORD: "test-only" },
    volumes: ["pgdata:/var/lib/postgresql/data"],
    advanced: { healthcheck: { test: ["CMD", "pg_isready", "-U", "app"], interval: "10s" } },
  };

  async function fixture(parsed = database) {
    const slug = `app-${++sequence}`;
    const group = await repos.projectGroup.create({ organizationId: "org", name: slug, slug });
    const project = await repos.project.create({
      groupId: group.id,
      organizationId: "org",
      name: slug,
      slug,
    });
    const [created] = await repos.service.syncFromCompose(project.id, [parsed], {
      composeAuthoritative: true,
    });
    await connection.db
      .update(schema.service)
      .set({ updatedAt: unchangedAt })
      .where(eq(schema.service.id, created!.id));
    const before = (await repos.service.findById(created!.id))!;
    return { project, before };
  }

  async function rawService(id: string) {
    return connection.db.query.service.findFirst({ where: eq(schema.service.id, id) });
  }

  it("does not write or advance timestamps across repeated folder and snapshot syncs", async () => {
    const { project, before } = await fixture();
    const rawBefore = await rawService(before.id);
    const update = vi.spyOn(connection.db, "update");
    try {
      // The folder ensure, build request, and worker all synchronize the same
      // service. None may mark an unchanged database dirty for the carry gate.
      for (let deployment = 0; deployment < 3; deployment++) {
        for (const options of [
          { composeAuthoritative: true },
          { removeMissing: false },
          { removeMissing: false },
        ]) {
          const [returned] = await repos.service.syncFromCompose(project.id, [database], options);
          expect(returned).toEqual(before);
          expect(await repos.service.findById(before.id)).toEqual(before);
        }
      }
      expect(update).not.toHaveBeenCalled();
      expect(await rawService(before.id)).toEqual(rawBefore);
      expect(await repos.service.listByProject(project.id)).toHaveLength(1);
    } finally {
      update.mockRestore();
    }
  });

  it("ignores JSON object key order, including encrypted environment and nested configuration", async () => {
    const { project, before } = await fixture();
    const rawBefore = await rawService(before.id);
    const [returned] = await repos.service.syncFromCompose(
      project.id,
      [
        {
          ...database,
          environment: { POSTGRES_PASSWORD: "test-only", POSTGRES_USER: "app" },
          advanced: { healthcheck: { interval: "10s", test: ["CMD", "pg_isready", "-U", "app"] } },
        },
      ],
      { composeAuthoritative: true },
    );
    expect(returned).toEqual(before);
    expect(await rawService(before.id)).toEqual(rawBefore);
  });

  it.each<[string, Partial<ParsedComposeService>]>([
    ["image", { image: "postgres:17-alpine" }],
    ["build context", { build: "./database" }],
    ["Dockerfile", { dockerfile: "Dockerfile.db" }],
    ["build args", { buildArgs: { VERSION: "17" } }],
    ["command", { command: "postgres -c max_connections=200" }],
    ["command argv", { commandArgv: ["postgres", "-c", "max_connections=200"] }],
    ["environment", { environment: { POSTGRES_USER: "changed", POSTGRES_PASSWORD: "test-only" } }],
    ["ports", { ports: ["5433:5432"] }],
    ["volumes", { volumes: ["other-data:/var/lib/postgresql/data"] }],
    ["dependencies", { dependsOn: ["init"] }],
    ["restart policy", { restart: "on-failure" }],
    ["healthcheck", { advanced: { healthcheck: { test: ["CMD", "false"] } } }],
    ["entrypoint", { advanced: { entrypoint: ["custom-entrypoint"] } }],
    ["resources", { advanced: { resources: { cpuCores: 2, memoryMb: 2048 } } }],
    ["shutdown grace", { advanced: { stopGracePeriod: "30s" } }],
    ["namespace", { advanced: { networkMode: "service:vpn" } }],
    [
      "routing",
      {
        exposed: true,
        publicEndpoints: [{ port: 5432, domainType: "custom", customDomain: "db.example.test" }],
      },
    ],
  ])("persists a real %s change and marks the service dirty", async (_name, patch) => {
    const { project, before } = await fixture();
    const [returned] = await repos.service.syncFromCompose(
      project.id,
      [{ ...database, ...patch }],
      {
        composeAuthoritative: true,
      },
    );
    const persisted = (await repos.service.findById(before.id))!;
    expect(persisted.updatedAt.getTime()).toBeGreaterThan(unchangedAt.getTime());
    expect(returned).toEqual(persisted);
    expect(persisted).toMatchObject(patch);
    expect(await repos.service.listByProject(project.id)).toHaveLength(1);

    // Replaying the now-applied configuration must be a no-op as well.
    const [again] = await repos.service.syncFromCompose(project.id, [{ ...database, ...patch }], {
      removeMissing: false,
    });
    expect(again).toEqual(persisted);
  });

  it.each(["sync", "reconcile"] as const)(
    "%s updates import metadata without dirtying identical runtime configuration",
    async (mode) => {
      const { project, before } = await fixture();
      await repos.service.update(before.id, {
        importedSpec: null,
        driftSpec: toComposeSpec({ ...database, image: "postgres:17-alpine" }),
      });
      await connection.db
        .update(schema.service)
        .set({ updatedAt: unchangedAt })
        .where(eq(schema.service.id, before.id));
      const rawBefore = await rawService(before.id);

      if (mode === "sync") {
        await repos.service.syncFromCompose(project.id, [database], { composeAuthoritative: true });
      } else {
        await repos.service.reconcileFromCompose(project.id, [database]);
      }

      expect(await repos.service.findById(before.id)).toEqual({
        ...before,
        importedSpec: toComposeSpec(database),
        driftSpec: null,
      });
      expect((await rawService(before.id))?.environment).toEqual(rawBefore?.environment);
    },
  );

  it("does not overwrite a concurrent edit or its timestamp when only import metadata changes", async () => {
    const { project, before } = await fixture();
    await repos.service.update(before.id, { importedSpec: null });
    await connection.db
      .update(schema.service)
      .set({ updatedAt: unchangedAt })
      .where(eq(schema.service.id, before.id));
    const list = repos.service.listByProject.bind(repos.service);
    let edited: Awaited<ReturnType<typeof repos.service.findById>>;
    const read = vi.spyOn(repos.service, "listByProject").mockImplementationOnce(async (id) => {
      const snapshot = await list(id);
      await repos.service.update(before.id, {
        environment: { ...database.environment, POSTGRES_USER: "edited" },
      });
      edited = await repos.service.findById(before.id);
      return snapshot;
    });
    try {
      const [returned] = await repos.service.syncFromCompose(project.id, [database], {
        composeAuthoritative: true,
      });
      const persisted = await repos.service.findById(before.id);
      expect(persisted?.environment).toEqual(edited?.environment);
      expect(persisted?.updatedAt).toEqual(edited?.updatedAt);
      expect(returned).toEqual(persisted);
    } finally {
      read.mockRestore();
    }
  });

  it("preserves operator fields, other service kinds, and newer services on snapshot replay", async () => {
    const { project, before } = await fixture();
    await repos.service.update(before.id, {
      enabled: false,
      sortOrder: 17,
      namespaceVolumes: false,
      advanced: { ...before.advanced, readiness: { enabled: true }, alias: "primary" },
    });
    const stored = await repos.service.findById(before.id);
    const sibling = await repos.service.create({
      projectId: project.id,
      name: "newer",
      image: "redis:7",
    });
    const monorepo = await repos.service.create({
      projectId: project.id,
      name: "db",
      kind: "monorepo",
      rootDirectory: "apps/db",
    });

    for (let attempt = 0; attempt < 3; attempt++) {
      const [returned] = await repos.service.syncFromCompose(project.id, [database], {
        removeMissing: false,
      });
      expect(returned).toEqual(stored);
    }
    expect(await repos.service.findById(sibling.id)).toEqual(sibling);
    expect(await repos.service.findById(monorepo.id)).toEqual(monorepo);
    expect(await repos.service.listByProject(project.id)).toHaveLength(3);
  });

  it("preserves structured command arguments when a snapshot echoes only the display string", async () => {
    const parsed = {
      ...database,
      command: "sh -c echo one && echo two",
      commandArgv: ["sh", "-c", "echo one && echo two"],
    };
    const { project, before } = await fixture(parsed);
    const { commandArgv: _, ...snapshot } = parsed;
    const [returned] = await repos.service.syncFromCompose(project.id, [snapshot], {
      removeMissing: false,
    });
    expect(returned).toEqual(before);
  });

  it("treats ordered command arguments as a real change", async () => {
    const parsed = { ...database, commandArgv: ["program", "first", "second"] };
    const { project, before } = await fixture(parsed);
    await repos.service.syncFromCompose(project.id, [
      { ...parsed, commandArgv: ["program", "second", "first"] },
    ]);
    const after = (await repos.service.findById(before.id))!;
    expect(after.commandArgv).toEqual(["program", "second", "first"]);
    expect(after.updatedAt.getTime()).toBeGreaterThan(unchangedAt.getTime());
  });

  it("marks a materialized restart policy as changed even if drift normalization treats it as a default", async () => {
    const { project, before } = await fixture();
    await connection.db
      .update(schema.service)
      .set({ restart: null, updatedAt: unchangedAt })
      .where(eq(schema.service.id, before.id));
    // Conservatively apply a newly persisted policy to legacy containers;
    // drift equality alone cannot establish their actual runtime defaults.
    await repos.service.syncFromCompose(project.id, [database]);
    const after = (await repos.service.findById(before.id))!;
    expect(after.restart).toBe("unless-stopped");
    expect(after.updatedAt.getTime()).toBeGreaterThan(unchangedAt.getTime());
  });
});
