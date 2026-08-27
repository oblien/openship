import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  discoverServerStack: vi.fn(),
  ensureProject: vi.fn(),
  excludeAlreadyManaged: vi.fn(),
  syncFromCompose: vi.fn(),
  updateService: vi.fn(),
  findProject: vi.fn(),
}));

vi.mock("@repo/db", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  repos: {
    project: { findById: h.findProject },
    service: {
      syncFromCompose: h.syncFromCompose,
      update: h.updateService,
    },
  },
}));

vi.mock("../projects/project-crud.service", () => ({
  ensureProject: h.ensureProject,
  createServicesProjectWithId: vi.fn(),
}));

vi.mock("./docker-inspect.service", () => ({
  discoverServerStack: h.discoverServerStack,
}));

vi.mock("./managed-containers", () => ({
  excludeAlreadyManaged: h.excludeAlreadyManaged,
}));

import { adoptServerStack, type RepoComposeService } from "./migrate.service";
import type { DiscoveredService } from "./docker-reconcile";

const discovered = {
  name: "running-api",
  source: "container",
  containerId: "container-api",
  image: "myorg/api:running",
  running: true,
  ports: [],
  env: {},
  volumes: [],
  networks: [],
  dependsOn: [],
  warnings: [],
} as DiscoveredService;

const repoService = (
  name: string,
  appPackage: string,
  templateKeys: string[] = [],
): RepoComposeService => ({
  name,
  build: "../../",
  dockerfile: "services/shared/Dockerfile",
  buildArgs: { APP_PACKAGE: appPackage },
  advanced: { buildArgTemplateKeys: templateKeys },
  ports: [],
  environment: {},
  dependsOn: [],
  volumes: [],
});

describe("adoptServerStack — repo-only build args (#689)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.discoverServerStack.mockResolvedValue({
      services: [discovered],
      groups: [{ project: "legacy", services: [discovered] }],
    });
    h.excludeAlreadyManaged.mockImplementation(async (services) => services);
    h.ensureProject.mockResolvedValue({ project_id: "project-1", created: true });
    h.findProject.mockResolvedValue({ id: "project-1", slug: "migrated" });
    h.syncFromCompose.mockImplementation(
      async (_projectId: string, rows: Array<Record<string, unknown> & { name: string }>) =>
        rows.map((row, index: number) => ({
          ...row,
          id: `service-${index + 1}`,
          namespaceVolumes: false,
          rootDirectory: null,
        })),
    );
  });

  it("passes args for mapped and not-yet-running repo services into the single sync", async () => {
    const repoServices = new Map<string, RepoComposeService>([
      ["api", repoService("api", "${API_PACKAGE:-@myorg/api}", ["APP_PACKAGE"])],
      ["worker", repoService("worker", "@myorg/worker")],
    ]);

    await adoptServerStack({
      serverId: "server-1",
      organizationId: "org-1",
      projectName: "Migrated",
      serviceNames: ["running-api"],
      serviceRenames: { "running-api": "api" },
      repoServices,
    });

    expect(h.syncFromCompose).toHaveBeenCalledOnce();
    const rows = h.syncFromCompose.mock.calls[0]![1] as Array<{
      name: string;
      buildArgs?: Record<string, string | null>;
      advanced?: { buildArgTemplateKeys?: string[] };
    }>;
    expect(rows.map(({ name, buildArgs, advanced }) => ({ name, buildArgs, advanced }))).toEqual([
      {
        name: "api",
        buildArgs: { APP_PACKAGE: "${API_PACKAGE:-@myorg/api}" },
        advanced: { buildArgTemplateKeys: ["APP_PACKAGE"] },
      },
      {
        name: "worker",
        buildArgs: { APP_PACKAGE: "@myorg/worker" },
        advanced: { buildArgTemplateKeys: [] },
      },
    ]);
  });
});
