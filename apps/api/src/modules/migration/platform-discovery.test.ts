import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderAccess } from "@repo/platform/engine/modules/credentials/provider-api";
const h = vi.hoisted(() => ({ railway: vi.fn(), vercel: vi.fn() }));
vi.mock("@repo/platform/engine/modules/credentials/provider-api", () => ({
  railwayQuery: h.railway,
  vercelRequest: h.vercel,
}));
import { railwayMigrationProvider } from "@repo/platform/engine/modules/migration/providers/railway";
import { vercelMigrationProvider } from "@repo/platform/engine/modules/migration/providers/vercel";
import { publicImportService } from "@repo/platform/engine/modules/migration/providers/types";

const access: ProviderAccess = {
  provider: "railway",
  secrets: { apiToken: "test-token" },
  publicFields: { tokenType: "project" },
};
const source = { connectionId: "connection", projectId: "project", environmentId: "environment" };
const page = (values: unknown[], cursor?: string) => ({
  edges: values.map((node) => ({ node })),
  pageInfo: { hasNextPage: !!cursor, endCursor: cursor ?? null },
});
beforeEach(() => vi.resetAllMocks());
describe("provider discovery", () => {
  it("restricts Railway project tokens to their granted environment and performs no scan outside it", async () => {
    h.railway.mockResolvedValue({
      projectToken: {
        project: { id: "project", name: "Project" },
        environment: { id: "environment", name: "Production" },
      },
    });
    await expect(
      railwayMigrationProvider.discover(access, { ...source, environmentId: "another" }),
    ).rejects.toMatchObject({ code: "MIGRATION_SOURCE_NOT_FOUND" });
    expect(h.railway).toHaveBeenCalledTimes(1);
  });
  it("discovers Railway service revisions, volumes and sealed variables without returning secret values", async () => {
    h.railway.mockImplementation(async (_access, query: string) => {
      if (query.includes("projectToken"))
        return {
          projectToken: {
            project: { id: "project", name: "Project" },
            environment: { id: "environment", name: "Production" },
          },
        };
      if (query.includes("serviceInstances"))
        return {
          environment: {
            serviceInstances: page([
              {
                id: "instance",
                serviceId: "service",
                serviceName: "app",
                source: { image: null, repo: "owner/repo" },
                rootDirectory: "/apps/web",
                dockerfilePath: null,
                buildCommand: "bun run build",
                startCommand: "bun start",
                cronSchedule: null,
                activeDeployments: [
                  {
                    id: "deployment",
                    meta: { commitHash: "a".repeat(40), branch: "main" },
                    deploymentStopped: false,
                  },
                ],
                domains: {
                  serviceDomains: [{ domain: "app.up.railway.app", targetPort: 3000 }],
                  customDomains: [],
                },
              },
            ]),
            volumeInstances: page([
              {
                id: "mount",
                serviceId: "service",
                mountPath: "/data",
                currentSizeMB: 12,
                deletedAt: null,
                isPendingDeletion: false,
                volume: { id: "volume", name: "Files" },
              },
            ]),
          },
        };
      if (query.includes("variablesForServiceDeployment"))
        return {
          raw: { TOKEN: "opaque", PORT: "3000", DATABASE_URL: "${{Postgres.DATABASE_URL}}" },
          resolved: {
            TOKEN: "not-exportable",
            PORT: "3000",
            DATABASE_URL: "postgres://user:secret@db.railway.internal:5432/app",
            SHARED: "shared-secret",
          },
        };
      return {
        raw: { SHARED: "shared-secret" },
        environment: {
          variables: page([
            { name: "TOKEN", serviceId: "service", isSealed: true },
            { name: "SHARED", serviceId: null, isSealed: false },
          ]),
        },
      };
    });
    const result = await railwayMigrationProvider.discover(access, source);
    expect(result.services[0]).toMatchObject({
      repository: "owner/repo",
      commit: "a".repeat(40),
      rootDirectory: "apps/web",
      port: 3000,
      volumes: [{ id: "mount", mountPath: "/data", sizeBytes: 12 * 1024 * 1024 }],
    });
    expect(result.services[0].env).not.toHaveProperty("TOKEN");
    expect(result.services[0].variables).toContainEqual({ key: "TOKEN", required: true });
    const publicResult = JSON.stringify(result.services.map(publicImportService));
    for (const secret of [
      "not-exportable",
      "shared-secret",
      "user:secret",
      "test-token",
      "${{Postgres.DATABASE_URL}}",
    ])
      expect(publicResult).not.toContain(secret);
  });
  it("uses nested workspace discovery for Railway account/OAuth tokens and follows all pages", async () => {
    h.railway.mockImplementation(async (_access, query: string, variables: any) => {
      if (query.includes("me { workspaces")) return { me: { workspaces: [{ id: "workspace" }] } };
      expect(query).toContain("workspace(workspaceId: $workspace)");
      return {
        workspace: {
          projects: page(
            [
              {
                id: variables.after ? "second" : "first",
                name: "Project",
                environments: page([
                  { id: "environment", name: "Production", canAccess: true, deletedAt: null },
                ]),
              },
            ],
            variables.after ? undefined : "next",
          ),
        },
      };
    });
    const result = await railwayMigrationProvider.projects({
      ...access,
      publicFields: { tokenType: "oauth" },
    });
    expect(result.map((p) => p.id)).toEqual(["first", "second"]);
  });
  it("keeps Vercel secret values missing and deduplicates shared external PostgreSQL connections", async () => {
    h.vercel.mockImplementation(async (_access, path: string) => {
      if (path === "/v9/projects/project")
        return {
          id: "project",
          name: "Website",
          link: { type: "github", org: "owner", repo: "site", productionBranch: "main" },
          targets: {
            production: {
              id: "deployment",
              meta: { githubCommitSha: "b".repeat(40), githubCommitRef: "main" },
            },
          },
        };
      if (path === "/v10/projects/project/env")
        return {
          envs: [
            { key: "TOKEN", type: "secret", target: ["production"], value: "opaque-secret" },
            { key: "PREVIEW_ONLY", type: "config", target: ["preview"], value: "preview-secret" },
            {
              key: "DATABASE_URL",
              type: "config",
              target: ["production"],
              value: "postgres://user:secret@db.example:5432/app?sslmode=require",
            },
            {
              key: "DIRECT_URL",
              type: "config",
              target: ["production"],
              value: "postgres://user:secret@db.example:5432/app?sslmode=require",
            },
            {
              id: "legacy",
              key: "LEGACY",
              type: "encrypted",
              target: ["production"],
              value: "ciphertext",
            },
          ],
        };
      if (path === "/v1/projects/project/env/legacy") return { value: "decrypted-secret" };
      return {
        domains: [{ name: "website.example" }, { name: "preview.example", gitBranch: "feature" }],
        pagination: { next: null },
      };
    });
    const result = await vercelMigrationProvider.discover(
      { ...access, provider: "vercel" },
      { ...source, environmentId: "production" },
    );
    expect(result.services).toHaveLength(2);
    expect(result.services[0].env).not.toHaveProperty("TOKEN");
    expect(result.services[0].env).not.toHaveProperty("PREVIEW_ONLY");
    expect(result.services[0].domains).toEqual([{ hostname: "website.example", portable: true }]);
    expect(result.services[0].rawEnv.DIRECT_URL).toBe(result.services[0].rawEnv.DATABASE_URL);
    const publicResult = JSON.stringify(result.services.map(publicImportService));
    for (const secret of [
      "opaque-secret",
      "preview-secret",
      "user:secret",
      "ciphertext",
      "decrypted-secret",
    ])
      expect(publicResult).not.toContain(secret);
  });
});

it("pins the deployed image and preserves readiness while blocking unsupported topology and hooks", async () => {
  const instance = {
    id: "instance",
    serviceId: "service",
    serviceName: "app",
    source: { image: "example/app:1", repo: null },
    rootDirectory: null,
    dockerfilePath: null,
    buildCommand: null,
    startCommand: "node server.js",
    cronSchedule: "0 * * * *",
    healthcheckPath: "/health",
    healthcheckTimeout: 45,
    numReplicas: 2,
    preDeployCommand: ["node migrate.js"],
    restartPolicyType: "ON_FAILURE",
    restartPolicyMaxRetries: 3,
    activeDeployments: [
      {
        id: "deployment",
        deploymentStopped: false,
        meta: { image: "example/app:1", imageDigest: `sha256:${"a".repeat(64)}` },
      },
    ],
    domains: {
      serviceDomains: [{ domain: "app.up.railway.app", targetPort: 3000 }],
      customDomains: [],
    },
  };
  h.railway.mockImplementation(async (_access, query: string) => {
    if (query.includes("projectToken"))
      return {
        projectToken: {
          project: { id: "project", name: "Project" },
          environment: { id: "environment", name: "Production" },
        },
      };
    if (query.includes("serviceInstances"))
      return { environment: { serviceInstances: page([instance]), volumeInstances: page([]) } };
    if (query.includes("variablesForServiceDeployment")) return { raw: {}, resolved: {} };
    return { raw: {}, environment: { variables: page([]) } };
  });
  const result = await railwayMigrationProvider.discover(access, source);
  expect(result.services[0]).toMatchObject({
    image: `example/app:1@sha256:${"a".repeat(64)}`,
    readiness: {
      enabled: true,
      path: "/health",
      port: 3000,
      timeoutSeconds: 45,
      onFailure: "fail",
    },
    restart: "on-failure:3",
  });
  const blockers = result.services[0].blockers.join(" ");
  expect(blockers).toContain("replica count");
  expect(blockers).toContain("pre-deploy command");
  expect(blockers).toContain("schedule");
  instance.activeDeployments = [];
  const stopped = await railwayMigrationProvider.discover(access, source);
  expect(stopped.services[0].instanceId).toBe("instance");
  expect(stopped.services[0].deploymentIds).toEqual([]);
});
