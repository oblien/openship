import { beforeEach, describe, expect, it, vi } from "vitest";
import { repos } from "@repo/db";
import type { ExecutionContext } from "@repo/platform";
import { seedOrg, seedProject } from "../../helpers/seed";

const io = vi.hoisted(() => ({ discover: vi.fn(), ensureProject: vi.fn() }));
vi.mock("@repo/platform/engine/modules/migration/docker-inspect.service", () => ({
  discoverServerStack: io.discover,
}));
vi.mock("@repo/platform/engine/modules/projects/project-crud.service", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  ensureProject: io.ensureProject,
}));

import {
  adoptServerStack,
  type RepoComposeService,
} from "@repo/platform/engine/modules/migration/migrate.service";
import type { DiscoveredService } from "@repo/platform/engine/modules/migration/docker-reconcile";
import {
  listServiceEnvVars,
  revealServiceEnvVars,
  setServiceEnvVars,
} from "@repo/platform/engine/modules/services/service.service";
import { decryptEnvMap, encrypt } from "@repo/platform/engine/lib/encryption";
import { ENV_MASK } from "@repo/platform/engine/lib/secret-env";
import { mergeServiceDeployEnv } from "@repo/platform/engine/modules/deployments/compose/service-env-layers";

const container = (containerId: string, env: Record<string, string>): DiscoveredService => ({
  name: "api",
  containerId,
  source: "container",
  image: "example/api:running",
  running: true,
  env,
  ports: ["3000"],
  volumes: [],
  networks: [],
  dependsOn: [],
  warnings: [],
});

describe("migration environments through the real service store and deploy merger", () => {
  let ctx: ExecutionContext;
  let projectId: string;
  beforeEach(async () => {
    vi.clearAllMocks();
    const org = await seedOrg();
    ctx = { ...org } as ExecutionContext;
    const project = await seedProject(org.organizationId, {
      name: "Migrated shop",
      projectType: "services",
    });
    projectId = project.id;
    io.ensureProject.mockResolvedValue({ project_id: projectId, created: true });
  }, 30_000);

  it("refuses unsupported live GPU settings before creating a project or saving service rows", async () => {
    io.discover.mockResolvedValue({
      services: [{ ...container("gpu-container", {}), gpuImportError: "Unsupported GPU request" }],
    });
    await expect(
      adoptServerStack({
        serverId: "server",
        organizationId: ctx.organizationId,
        projectName: "GPU application",
        serviceContainerIds: ["gpu-container"],
        ctx,
      }),
    ).rejects.toThrow(/Unsupported GPU/);
    expect(io.ensureProject).not.toHaveBeenCalled();
    expect(await repos.service.listByProject(projectId)).toEqual([]);
  });

  it("saves, reveals, rotates and deploys exact live values under renamed service IDs", async () => {
    const secret = "literal ${DO_NOT_EXPAND} 'quoted' $value\nsecond=line";
    io.discover.mockResolvedValue({
      services: [
        container("frontend-container", {
          API_TOKEN: secret,
          API_URL: "https://old.example.com",
          REMOVE: "old",
        }),
        container("backend-container", { API_TOKEN: "backend-secret", MODE: "backend" }),
      ],
    });
    await repos.project.bulkSetEnvVars(projectId, "production", [
      { key: "SHARED", value: encrypt("shared") },
    ]);
    await adoptServerStack({
      serverId: "remote-server",
      organizationId: ctx.organizationId,
      projectName: "Migrated shop",
      sameServer: true,
      serviceNames: ["api"],
      serviceContainerIds: ["frontend-container", "backend-container"],
      serviceRenames: { "frontend-container": "frontend", "backend-container": "backend" },
      serviceEnv: {
        "frontend-container": {
          API_TOKEN: ENV_MASK,
          API_URL: "https://new.example.com",
          REMOVE: "old",
        },
      },
      volumeStrategies: { "frontend-container": "copy" },
    });
    const rows = await repos.service.listByProject(projectId);
    const frontend = rows.find((service) => service.name === "frontend")!;
    const backend = rows.find((service) => service.name === "backend")!;
    expect(frontend.namespaceVolumes).toBe(true);
    expect(backend.namespaceVolumes).toBe(false);
    expect(frontend.environment).toEqual({});
    expect(await revealServiceEnvVars(ctx, projectId, frontend.id, "production")).toEqual({
      API_TOKEN: secret,
      API_URL: "https://new.example.com",
      REMOVE: "old",
    });
    expect(
      (await listServiceEnvVars(ctx, projectId, frontend.id, "production")).find(
        (row) => row.key === "API_TOKEN",
      )?.value,
    ).toBe(ENV_MASK);
    const ciphertext = (await repos.project.getEnvMap(projectId, "production", frontend.id))
      .API_TOKEN;
    expect(ciphertext).not.toContain(secret);

    await setServiceEnvVars(ctx, projectId, frontend.id, {
      environment: "production",
      vars: [
        { key: "API_TOKEN", value: ENV_MASK },
        { key: "API_URL", value: "https://rotated.example.com" },
      ],
    });
    const merged = mergeServiceDeployEnv(
      {
        project: decryptEnvMap(await repos.project.getEnvMap(projectId, "production", null)),
        frozen: {},
        inline: frontend.environment ?? {},
        service: decryptEnvMap(await repos.project.getEnvMap(projectId, "production", frontend.id)),
      },
      false,
    );
    expect(merged.env).toEqual({
      SHARED: "shared",
      API_TOKEN: secret,
      API_URL: "https://rotated.example.com",
    });
    expect(await revealServiceEnvVars(ctx, projectId, backend.id, "production")).toEqual({
      API_TOKEN: "backend-secret",
      MODE: "backend",
    });
  });

  it("keeps Compose expressions as source defaults and wizard edits as service overrides", async () => {
    io.discover.mockResolvedValue({
      services: [container("container-api", { VALUE: "runtime-literal", PASSWORD: "live-secret" })],
    });
    const repo: RepoComposeService = {
      name: "api",
      image: "example/api:latest",
      ports: ["3000"],
      dependsOn: [],
      volumes: [],
      environment: { VALUE: "default", PASSWORD: "" },
      environmentTemplates: { PASSWORD: "${PASSWORD}" },
      advanced: { environmentTemplateKeys: ["PASSWORD"] },
    };
    await adoptServerStack({
      serverId: "remote-server",
      organizationId: ctx.organizationId,
      projectName: "Migrated shop",
      serviceNames: ["api"],
      repoServices: new Map([["api", repo]]),
    });
    const [service] = await repos.service.listByProject(projectId);
    expect(service.environment).toEqual({ VALUE: "default", PASSWORD: "${PASSWORD}" });
    const merged = mergeServiceDeployEnv(
      {
        project: {},
        frozen: {},
        inline: service.environment!,
        templateKeys: service.advanced?.environmentTemplateKeys,
        service: decryptEnvMap(await repos.project.getEnvMap(projectId, "production", service.id)),
      },
      false,
    );
    expect(merged.env).toEqual({ VALUE: "runtime-literal", PASSWORD: "live-secret" });
  });

  it("honors an explicitly empty wizard environment instead of importing the live secrets again", async () => {
    io.discover.mockResolvedValue({
      services: [container("container-api", { API_TOKEN: "do-not-import" })],
    });
    await adoptServerStack({
      serverId: "remote-server",
      organizationId: ctx.organizationId,
      projectName: "Migrated shop",
      serviceNames: ["api"],
      serviceEnv: { "container-api": {} },
    });
    const [service] = await repos.service.listByProject(projectId);
    expect(await revealServiceEnvVars(ctx, projectId, service.id, "production")).toEqual({});
    expect(service.environment).toEqual({});
  });
});
