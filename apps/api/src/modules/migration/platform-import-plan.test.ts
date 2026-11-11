import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecutionContext } from "@repo/platform";
import type {
  ProviderInventory,
  ProviderService,
} from "@repo/platform/engine/modules/migration/providers/types";

const h = vi.hoisted(() => ({
  cache: new Map<string, string>(),
  admin: vi.fn(),
  authorize: vi.fn(),
  server: vi.fn(),
  access: vi.fn(),
  discover: vi.fn(),
  info: vi.fn(),
  readText: vi.fn(),
}));
vi.mock("@repo/platform/engine/lib/cache-store", () => ({
  cacheStore: async (name: string) => ({
    set: async (key: string, value: string) => {
      h.cache.set(`${name}:${key}`, value);
    },
    get: async (key: string) => h.cache.get(`${name}:${key}`),
  }),
}));
vi.mock("@repo/platform/engine/lib/encryption", () => ({
  encrypt: (s: string) => Buffer.from(s).toString("base64"),
  decrypt: (s: string) => Buffer.from(s, "base64").toString(),
}));
vi.mock("@repo/platform/engine/lib/organization-authorization", () => ({
  requireOrganizationAdmin: h.admin,
}));
vi.mock("@repo/platform/engine/lib/authorization", () => ({
  authorization: { authorize: h.authorize },
}));
vi.mock("@repo/platform/engine/modules/migration/migration-access", () => ({
  requireMigrationServer: h.server,
}));
vi.mock("@repo/platform/engine/modules/credentials/connection-authorization", () => ({
  getProviderAccess: h.access,
}));
vi.mock("@repo/platform/engine/modules/deployments/prepare.service", () => ({
  resolveProjectInfo: h.info,
}));
vi.mock("@repo/platform/engine/modules/deployments/project-reader", () => ({
  createGitHubReader: () => ({ readText: h.readText }),
}));
vi.mock("@repo/platform/engine/modules/migration/providers/railway", () => ({
  railwayMigrationProvider: { discover: h.discover },
}));
vi.mock("@repo/platform/engine/modules/migration/providers/vercel", () => ({
  vercelMigrationProvider: { discover: h.discover },
}));
import {
  discoverPlatform,
  reviewPlatform,
  loadReviewedImport,
  inventoryFingerprint,
} from "@repo/platform/engine/modules/migration/platform-import-plan";

const ctx = { organizationId: "org", userId: "user" } as ExecutionContext;
const source = { connectionId: "connection", projectId: "project", environmentId: "production" };
const service = (patch: Partial<ProviderService> = {}): ProviderService => ({
  id: "app",
  name: "App",
  kind: "app",
  image: "example/app:1",
  port: 3000,
  env: {},
  rawEnv: {},
  variables: [],
  volumes: [],
  domains: [],
  warnings: [],
  blockers: [],
  ...patch,
});
const database = () =>
  service({
    id: "db",
    name: "Postgres",
    kind: "database",
    database: "pg_dump",
    image: "postgres:17",
    instanceId: "instance",
    privateDomain: "db.railway.internal",
    port: 5432,
    env: {
      POSTGRES_USER: "app",
      POSTGRES_PASSWORD: "source-secret",
      POSTGRES_DB: "app",
      PGHOST: "db.railway.internal",
      PGPORT: "56789",
    },
    volumes: [{ id: "data", mountPath: "/var/lib/postgresql/data" }],
  });
let inventory: ProviderInventory;
beforeEach(() => {
  vi.resetAllMocks();
  h.cache.clear();
  inventory = {
    provider: "railway",
    source,
    projectName: "Project",
    environmentName: "Production",
    services: [
      database(),
      service({
        env: { DATABASE_URL: "postgres://app:source-secret@db.railway.internal/app" },
        rawEnv: { DATABASE_URL: "${{Postgres.DATABASE_URL}}" },
      }),
    ],
    warnings: [],
  };
  h.access.mockResolvedValue({ provider: "railway" });
  h.discover.mockImplementation(async () => structuredClone(inventory));
  h.server.mockResolvedValue({ id: "server", organizationId: "org" });
  h.info.mockResolvedValue({
    projectType: "app",
    stack: "nextjs",
    packageManager: "bun",
    productionPaths: [],
    port: 3000,
  });
});
async function review(
  services = [
    { id: "db", name: "Database", data: "copy" as const },
    { id: "app", name: "Website", data: "empty" as const },
  ],
) {
  const draft = await discoverPlatform(ctx, source);
  return reviewPlatform(ctx, { draftId: draft.draftId, targetServerId: "server", services });
}

describe("reviewed platform imports", () => {
  it("keeps secrets server-side and replaces provider database addresses with shared project bindings", async () => {
    const plan = await review();
    expect(plan.ready).toBe(true);
    expect(plan.requiresWritePause).toBe(true);
    expect(JSON.stringify(plan)).not.toContain("source-secret");
    const privatePlan = await loadReviewedImport(ctx, plan.planId);
    expect(privatePlan.services[1].bindings).toEqual([
      {
        sourceId: "db",
        envKey: "DATABASE_URL",
        valueTemplate: "postgres://app:source-secret@${host}/app",
      },
    ]);
    expect(privatePlan.services[1].environment).not.toHaveProperty("DATABASE_URL");
    expect(privatePlan.services[0].environment.PGHOST).toBe(
      privatePlan.services[0].create.internalAlias,
    );
    expect(privatePlan.sourceControl).toBe("railway-project");
    expect(privatePlan.services.every((s) => s.transfer === "cold-volume")).toBe(true);
    expect(privatePlan.services[0].environment.POSTGRES_PASSWORD).toBe("source-secret");
    expect(h.authorize).toHaveBeenCalledWith(ctx, {
      resourceType: "server",
      resourceId: "server",
      action: "write",
    });
    for (const value of h.cache.values()) expect(value).not.toContain("source-secret");
  });
  it("rejects another workspace or user and detects changes after review", async () => {
    const plan = await review();
    for (const context of [
      { ...ctx, organizationId: "other" },
      { ...ctx, userId: "other" },
    ])
      await expect(loadReviewedImport(context, plan.planId)).rejects.toMatchObject({
        code: "IMPORT_NOT_FOUND",
      });
    inventory.services[0].env.POSTGRES_PASSWORD = "changed";
    await expect(loadReviewedImport(ctx, plan.planId)).rejects.toMatchObject({
      code: "IMPORT_SOURCE_CHANGED",
    });
  });
  it("ignores pagination order and changing volume size, but never ignores changed configuration", () => {
    const next = structuredClone(inventory);
    next.services.reverse();
    next.services[1].volumes[0].sizeBytes = 200;
    expect(inventoryFingerprint(next)).toBe(inventoryFingerprint(inventory));
    next.services[1].volumes[0].mountPath = "/another";
    expect(inventoryFingerprint(next)).not.toBe(inventoryFingerprint(inventory));
  });
  it("blocks missing secrets, unsupported references and databases without persistent mounts", async () => {
    inventory.services[0].volumes = [];
    inventory.services[1].variables = [{ key: "TOKEN", required: true }];
    inventory.services[1].rawEnv = {
      URL: "${{Postgres.PGHOST}}",
      DATABASE_URL: "${{Postgres.DATABASE_URL}}",
    };
    inventory.services[1].env.URL = "${{Postgres.PGHOST}}";
    const plan = await review();
    expect(plan.ready).toBe(false);
    expect(plan.services[0].blockers.join(" ")).toContain("no persistent volume");
    expect(plan.services[1].blockers.join(" ")).toContain("Provide TOKEN");
    expect(plan.services[1].blockers.join(" ")).toContain("Review URL");
  });
  it("uses the resolved endpoint instead of guessing an engine from the variable name", async () => {
    inventory.services[1].rawEnv = { DATABASE_URL: "${{Postgres.REDIS_URL}}" };
    const reviewed = await review();
    expect(reviewed.ready).toBe(true);
    expect(
      (await loadReviewedImport(ctx, reviewed.planId)).services[1].bindings[0].valueTemplate,
    ).toBe("postgres://app:source-secret@${host}/app");
  });
  it("rejects conflicting project names and enforces destination access before planning", async () => {
    await expect(
      review([
        { id: "db", name: "Same Name", data: "copy" },
        { id: "app", name: "same-name", data: "empty" },
      ]),
    ).rejects.toMatchObject({ code: "IMPORT_NAME_INVALID" });
    h.authorize.mockRejectedValue(new Error("forbidden"));
    await expect(review()).rejects.toThrow("forbidden");
  });
  it("discovers a non-exportable Vercel database after its secret is supplied, then imports it using normal bindings", async () => {
    inventory.provider = "vercel";
    h.access.mockResolvedValue({ provider: "vercel" });
    inventory.services = [
      service({
        image: undefined,
        repository: "owner/repo",
        commit: "a".repeat(40),
        variables: [{ key: "DATABASE_URL", required: true }],
      }),
    ];
    const draft = await discoverPlatform(ctx, source);
    const app = {
      id: "app",
      name: "Website",
      data: "empty" as const,
      env: { DATABASE_URL: "postgres://user:secret@db.example/app?sslmode=require" },
    };
    const first = await reviewPlatform(ctx, {
      draftId: draft.draftId,
      targetServerId: "server",
      services: [app],
    });
    const external = first.services.find((s) => s.external)!;
    expect(external).toBeDefined();
    expect(JSON.stringify(first)).not.toContain("secret@db");
    const plan = await reviewPlatform(ctx, {
      draftId: draft.draftId,
      targetServerId: "server",
      services: [app, { id: external.id, name: "Database", data: "copy", databaseVersion: "18" }],
    });
    expect(plan.ready).toBe(true);
    const privatePlan = await loadReviewedImport(ctx, plan.planId);
    expect(privatePlan.services[0].bindings).toEqual([
      { sourceId: external.id, envKey: "DATABASE_URL" },
    ]);
    expect(privatePlan.services[1].create.services?.[0].volumes).toEqual([
      "data-0:/var/lib/postgresql",
    ]);
    // Supplying secrets does not falsely report provider configuration drift.
    expect(h.discover).toHaveBeenCalledTimes(2);
  });
});

it("uses the existing Compose build for a custom Dockerfile and preserves readiness", async () => {
  inventory.services = [
    service({
      image: undefined,
      repository: "owner/repo",
      commit: "a".repeat(40),
      rootDirectory: "apps/api",
      dockerfile: "docker/production.Dockerfile",
      readiness: { enabled: true, path: "/health", port: 3000, onFailure: "fail" },
    }),
  ];
  h.readText.mockResolvedValue("FROM node:22");
  const result = await review([{ id: "app", name: "App", data: "empty" }]);
  expect(result.ready).toBe(true);
  const plan = await loadReviewedImport(ctx, result.planId);
  expect(h.readText).toHaveBeenCalledWith("apps/api/docker/production.Dockerfile");
  expect(plan.services[0].create).toMatchObject({
    rootDirectory: ".",
    projectType: "services",
    readiness: { path: "/health" },
    services: [{ build: "apps/api", dockerfile: "docker/production.Dockerfile" }],
  });
  expect(h.info).not.toHaveBeenCalled();
});
it("blocks an unavailable custom Dockerfile before import", async () => {
  inventory.services = [
    service({
      image: undefined,
      repository: "owner/repo",
      commit: "a".repeat(40),
      dockerfile: "Dockerfile.prod",
    }),
  ];
  h.readText.mockResolvedValue(undefined);
  const result = await review([{ id: "app", name: "App", data: "empty" }]);
  expect(result.ready).toBe(false);
  expect(result.services[0].blockers.join(" ")).toContain("Dockerfile was not found");
});
