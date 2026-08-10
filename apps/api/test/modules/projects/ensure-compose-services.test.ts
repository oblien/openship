import "../mail/_setup-env";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * projects/ensure must persist the compose services it is handed (#334).
 *
 * The folder-upload flow is session → scan → ensure → deploy: the scan parses
 * the uploaded docker-compose.yml, and `ensure` is the step that owns the
 * project's config. When it dropped the scan's `services`, the first deploy ran
 * the services pipeline against zero rows and failed with "No services were
 * found for this project".
 */
const projectRepo = vi.hoisted(() => ({
  findById: vi.fn(),
  findBySlugInOrg: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
}));

const projectGroupRepo = vi.hoisted(() => ({
  findBySlugInOrg: vi.fn(),
  listByOrganization: vi.fn(),
  listByGroup: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  softDelete: vi.fn(),
}));

const serviceRepo = vi.hoisted(() => ({
  listByProject: vi.fn(),
  syncFromCompose: vi.fn(),
  syncMonorepoApps: vi.fn(),
}));

// Fully mocked (no importOriginal) so the test never boots a real PGlite —
// ensureProject only ever touches these three repos.
vi.mock("@repo/db", () => ({
  repos: {
    project: projectRepo,
    projectGroup: projectGroupRepo,
    service: serviceRepo,
    settings: { listCloudLinkedOrgIds: vi.fn().mockResolvedValue([]) },
    domain: { getPrimaryByProject: vi.fn().mockResolvedValue(null) },
  },
  db: { select: vi.fn() },
  schema: {},
  eq: vi.fn(),
  getDriver: () => "postgres",
}));

vi.mock("../../../src/modules/domains/project-route.service", () => ({
  deriveEnvironmentPublicEndpoints: vi.fn(),
  deriveNextProjectRouteState: vi.fn(() => ({ publicEndpoints: [] })),
  persistProjectRouteState: vi.fn(),
  reapplyProjectLiveRoutes: vi.fn(),
  resolveProjectRouteState: vi.fn(),
  syncProjectRouteState: vi.fn(),
}));

vi.mock("../../../src/modules/domains/routing-apply.service", () => ({
  applyProjectRouting: vi.fn(),
}));

import { ensureProject } from "../../../src/modules/projects/project-crud.service";
import { ENV_MASK } from "../../../src/lib/secret-env";
import {
  newFolderSessionId,
  putFolderSession,
} from "../../../src/modules/projects/folder/session-store";

/** A two-service compose, exactly as folder/scan returns it. */
const scannedServices = [
  {
    name: "api",
    image: "ghcr.io/acme/api:1",
    ports: ["8080:8080"],
    dependsOn: ["db"],
    environment: { NODE_ENV: "production" },
    volumes: [],
  },
  { name: "db", image: "postgres:16", volumes: ["db-data:/var/lib/postgresql/data"] },
];

const existingProject = {
  id: "proj_1",
  organizationId: "org_1",
  groupId: "grp_1",
  slug: "my-stack",
  name: "my-stack",
  environmentSlug: "production",
  gitBranch: "main",
};

describe("ensureProject compose services", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    projectRepo.findById.mockResolvedValue(null);
    projectRepo.findBySlugInOrg.mockResolvedValue(null);
    projectRepo.create.mockResolvedValue({ id: "proj_new", groupId: "grp_new" });
    projectGroupRepo.findBySlugInOrg.mockResolvedValue(null);
    projectGroupRepo.listByOrganization.mockResolvedValue({ total: 0, rows: [] });
    projectGroupRepo.create.mockResolvedValue({ id: "grp_new" });
    serviceRepo.listByProject.mockResolvedValue([]);
    serviceRepo.syncFromCompose.mockResolvedValue([]);
  });

  it("persists the scanned services on the project it creates", async () => {
    const result = await ensureProject(
      {
        name: "my-stack",
        gitProvider: "upload",
        framework: "docker-compose",
        projectType: "services",
        services: scannedServices,
      } as any,
      "org_1",
    );

    expect(result.created).toBe(true);
    expect(serviceRepo.syncFromCompose).toHaveBeenCalledWith("proj_new", scannedServices);
  });

  it("re-syncs the services when updating an existing project", async () => {
    projectRepo.findById.mockResolvedValue(existingProject);

    const result = await ensureProject(
      {
        projectId: "proj_1",
        name: "my-stack",
        framework: "docker-compose",
        projectType: "services",
        services: scannedServices,
      } as any,
      "org_1",
    );

    expect(result.created).toBe(false);
    expect(serviceRepo.syncFromCompose).toHaveBeenCalledWith("proj_1", scannedServices);
  });

  it("leaves the service table alone when the request carries no services", async () => {
    await ensureProject({ name: "single-app", framework: "nextjs" } as any, "org_1");

    expect(serviceRepo.syncFromCompose).not.toHaveBeenCalled();
  });

  it("never wipes rows with an empty list (a caller that sent services: [])", async () => {
    projectRepo.findById.mockResolvedValue(existingProject);

    await ensureProject(
      { projectId: "proj_1", name: "my-stack", services: [] } as any,
      "org_1",
    );

    expect(serviceRepo.syncFromCompose).not.toHaveBeenCalled();
  });
});

/**
 * #336 crossover: the scan MASKS env on output, so a client echoing the scan's
 * `services` into ensure sends the sentinel. It must never be persisted — a
 * container launching with KEY=•••••••• is worse than the original bug.
 */
describe("ensureProject compose services — masked env", () => {
  /** What the client actually receives back from folder/scan. */
  const maskedServices = [
    { name: "api", image: "ghcr.io/acme/api:1", environment: { DB_PASSWORD: ENV_MASK } },
  ];

  function seedScannedSession(overrides: Record<string, unknown> = {}): string {
    const id = newFolderSessionId();
    putFolderSession({
      id,
      orgId: "org_1",
      userId: "user_1",
      mode: "api-relay",
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      stagingDir: "/tmp/openship-upload-y",
      uploaded: true,
      services: [{ name: "api", environment: { DB_PASSWORD: "s3cret" } }] as any,
      ...overrides,
    } as any);
    return id;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    projectRepo.findById.mockResolvedValue(null);
    projectRepo.findBySlugInOrg.mockResolvedValue(null);
    projectRepo.create.mockResolvedValue({ id: "proj_new", groupId: "grp_new" });
    projectGroupRepo.findBySlugInOrg.mockResolvedValue(null);
    projectGroupRepo.listByOrganization.mockResolvedValue({ total: 0, rows: [] });
    projectGroupRepo.create.mockResolvedValue({ id: "grp_new" });
    serviceRepo.listByProject.mockResolvedValue([]);
    serviceRepo.syncFromCompose.mockResolvedValue([]);
  });

  it("restores masked values from the upload session that captured them", async () => {
    const uploadSessionId = seedScannedSession();

    await ensureProject(
      { name: "my-stack", services: maskedServices, uploadSessionId } as any,
      "org_1",
    );

    expect(serviceRepo.syncFromCompose).toHaveBeenCalledWith("proj_new", [
      expect.objectContaining({ environment: { DB_PASSWORD: "s3cret" } }),
    ]);
  });

  it("restores from the stored row when re-ensuring an existing project", async () => {
    projectRepo.findById.mockResolvedValue(existingProject);
    serviceRepo.listByProject.mockResolvedValue([
      { id: "svc_1", name: "api", kind: "compose", environment: { DB_PASSWORD: "from-row" } },
    ]);

    await ensureProject(
      { projectId: "proj_1", name: "my-stack", services: maskedServices } as any,
      "org_1",
    );

    expect(serviceRepo.syncFromCompose).toHaveBeenCalledWith("proj_1", [
      expect.objectContaining({ environment: { DB_PASSWORD: "from-row" } }),
    ]);
  });

  it("drops a masked value with no source instead of persisting the sentinel", async () => {
    await ensureProject({ name: "my-stack", services: maskedServices } as any, "org_1");

    expect(serviceRepo.syncFromCompose).toHaveBeenCalledWith("proj_new", [
      expect.objectContaining({ environment: {} }),
    ]);
  });

  it("ignores an upload session belonging to another org", async () => {
    const uploadSessionId = seedScannedSession({ orgId: "org_other" });

    await ensureProject(
      { name: "my-stack", services: maskedServices, uploadSessionId } as any,
      "org_1",
    );

    expect(serviceRepo.syncFromCompose).toHaveBeenCalledWith("proj_new", [
      expect.objectContaining({ environment: {} }),
    ]);
  });

  it("passes revealed/edited values through untouched", async () => {
    const uploadSessionId = seedScannedSession();
    const edited = [{ name: "api", image: "ghcr.io/acme/api:1", environment: { DB_PASSWORD: "typed-by-user" } }];

    await ensureProject(
      { name: "my-stack", services: edited, uploadSessionId } as any,
      "org_1",
    );

    expect(serviceRepo.syncFromCompose).toHaveBeenCalledWith("proj_new", edited);
    // No mask anywhere → no need to read rows back at all.
    expect(serviceRepo.listByProject).not.toHaveBeenCalled();
  });
});
