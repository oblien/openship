import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Creating an environment must leave NOTHING behind when it fails.
 *
 * The reported bug was one click producing three symptoms. `createProjectEnvironment`
 * called `repos.project.create()` and only then derived a free subdomain and ran
 * `assertFreeEndpointsAllowed`, which throws on a Cloud-disconnected instance. The
 * row was already committed, so:
 *
 *   1. the request answered 400 while the environment existed;
 *   2. the retry hit the "already exists" guard;
 *   3. a reload offered a switchable, half-built environment with no routing.
 *
 * `createProject` states the rule a few hundred lines up — gate "BEFORE any
 * group/project row is written … so a rejected create leaves nothing behind" — and
 * also exempts auto-derived endpoints from that gate entirely, because "that path
 * must keep working on a self-hosted instance". The environment path did neither.
 *
 * So the properties pinned here are: nothing is written when validation fails, and
 * the create path never touches routing at all.
 */

const h = vi.hoisted(() => ({
  base: {
    id: "proj_prod",
    organizationId: "org_1",
    groupId: "grp_1",
    name: "Site",
    slug: "site",
    environmentSlug: "production",
    environmentType: "production",
    gitProvider: "github",
    framework: "node",
    gitOwner: "acme",
    gitRepo: "site",
    gitBranch: "main",
    gitUrl: "https://github.com/acme/site.git",
    installationId: 42 as number | null,
    localPath: null as string | null,
    releaseSource: null as Record<string, unknown> | null,
    sourceKind: null as string | null,
    buildKind: null as string | null,
    workloadType: "web",
    runtimeMode: null as string | null,
    hasBuild: true,
    hasServer: true,
    startCommand: "npm start" as string | null,
    webhookId: 17 as number | null,
    webhookDomain: "hooks.example.com" as string | null,
    autoDeploy: true,
    isApp: false,
    activeDeploymentId: null as string | null,
    serverId: null as string | null,
    resources: null,
    buildResources: null,
  },
  siblings: [] as Array<Record<string, unknown>>,
  branches: [{ name: "main" }, { name: "staging" }] as Array<{ name: string }>,
  creates: [] as Array<Record<string, unknown>>,
  groupCreates: [] as Array<Record<string, unknown>>,
  freeGateCalls: 0,
  persistedRoutes: [] as Array<unknown>,
}));

vi.mock("@repo/db", () => ({
  repos: {
    project: {
      findById: async () => ({ ...h.base }),
      listByGroup: async () => h.siblings,
      findBySlugInOrg: async () => null,
      create: async (input: Record<string, unknown>) => {
        h.creates.push(input);
        return { ...h.base, ...input, id: "proj_new" };
      },
      listByOrganization: async () => ({ rows: [], total: 0 }),
    },
    projectGroup: {
      findById: async () => ({ id: "grp_1", name: "Site", slug: "site" }),
      findBySlugInOrg: async () => null,
      listByOrganization: async () => ({ rows: [], total: 0 }),
      create: async (input: Record<string, unknown>) => {
        h.groupCreates.push(input);
        return { ...input, id: "grp_new" };
      },
      softDelete: async () => {},
    },
    deployment: { findById: async () => null, listByProject: async () => ({ rows: [] }) },
    service: { listByProject: async () => [] },
    domain: { listByProject: async () => [] },
    server: { getInOrganization: async () => null },
    dockerMigrationRun: { findActiveForProject: async () => null },
  },
}));

// The seams that prove property 2: the create path must not reach any of them.
vi.mock("../domains/project-route.service", () => ({
  syncProjectRouteState: async () => ({ projectDomains: [], publicEndpoints: [] }),
  reapplyProjectLiveRoutes: async () => {},
  resolveProjectRouteState: async () => ({ projectDomains: [], publicEndpoints: [] }),
  listProjectRouteRows: async () => [],
  persistProjectRouteState: async (_id: string, endpoints: unknown) => {
    h.persistedRoutes.push(endpoints);
  },
  deriveNextProjectRouteState: () => ({ projectDomains: [], publicEndpoints: [] }),
  deriveEnvironmentPublicEndpoints: () => [{ domain: "site-staging.opsh.io", domainType: "free" }],
}));
vi.mock("../../lib/free-domain-guard", () => ({
  assertFreeEndpointsAllowed: async () => {
    h.freeGateCalls += 1;
  },
}));

vi.mock("../domains/routing-apply.service", () => ({ applyProjectRouting: async () => {} }));
vi.mock("./project-runtime.service", () => ({ syncProjectManagedEdge: async () => {} }));
vi.mock("../../lib/controller-helpers", () => ({
  assertResourceInOrg: () => {},
  platform: () => ({ runtime: { name: "docker" } }),
}));
vi.mock("../github/github.service", () => ({
  resolveDefaultBranch: async () => "main",
  listBranches: async () => h.branches,
  getLatestCommit: async () => null,
  resolveWebhookStrategy: async () => ({}),
}));
vi.mock("../github/github.auth", () => ({
  getInstallationIdByOrg: async () => undefined,
  getInstallUrl: () => "",
}));
vi.mock("./project-git-webhook", () => ({
  ensureSharedWebhook: async () => null,
  findSharedWebhookId: async () => null,
}));
vi.mock("../../lib/release-resolver", () => ({
  resolveLatestVersion: async () => null,
  resolveLatestReleaseTag: async () => null,
  readApiVersion: () => "0.0.0",
}));
vi.mock("../../lib/image-registry", () => ({ resolveLatestImageDigest: async () => null }));
vi.mock("./folder/session-store", () => ({ getFolderSession: () => null }));
vi.mock("../../config", () => ({ env: { CLOUD_MODE: false, CLOUD_MAX_PROJECTS_PER_USER: 20 } }));

const load = () => import("./project-crud.service");
const ctx = { userId: "user_1", organizationId: "org_1" } as never;

describe("createProjectEnvironment", () => {
  beforeEach(() => {
    Object.assign(h.base, {
      gitProvider: "github",
      framework: "node",
      gitOwner: "acme",
      gitRepo: "site",
      gitUrl: "https://github.com/acme/site.git",
      installationId: 42,
      localPath: null,
      releaseSource: null,
      sourceKind: null,
      buildKind: null,
      runtimeMode: null,
      hasBuild: true,
      startCommand: "npm start",
      webhookId: 17,
      webhookDomain: "hooks.example.com",
      autoDeploy: true,
    });
    h.siblings = [{ ...h.base }];
    h.branches = [{ name: "main" }, { name: "staging" }];
    h.creates = [];
    h.groupCreates = [];
    h.freeGateCalls = 0;
    h.persistedRoutes = [];
  });

  it("writes NO row when the branch does not exist", async () => {
    const { createProjectEnvironment } = await load();
    await expect(
      createProjectEnvironment("proj_prod", ctx, {
        environmentName: "Ghost",
        gitBranch: "no-such-branch",
        sourceMode: "branch",
      } as never),
    ).rejects.toThrow(/was not found/);

    // The whole cascade started with a failed create that had already committed.
    expect(h.creates).toEqual([]);
  });

  it("never touches routing on the create path", async () => {
    const { createProjectEnvironment } = await load();
    await createProjectEnvironment("proj_prod", ctx, {
      environmentName: "Staging",
      gitBranch: "staging",
      sourceMode: "branch",
    } as never);

    expect(h.creates).toHaveLength(1);
    // Not gated, and nothing persisted: an environment is born with no endpoints and
    // `build.service` mints `defaultFreeEndpoint` on deploy instead — on the path that
    // actually carries the Cloud and quota checks.
    expect(h.freeGateCalls).toBe(0);
    expect(h.persistedRoutes).toEqual([]);
    expect(h.creates[0]).not.toHaveProperty("publicEndpoints");
  });

  it("still refuses a duplicate environment slug", async () => {
    h.siblings = [{ ...h.base }, { ...h.base, id: "proj_stg", environmentSlug: "staging" }];
    const { createProjectEnvironment } = await load();
    await expect(
      createProjectEnvironment("proj_prod", ctx, {
        environmentName: "Staging",
        gitBranch: "staging",
        sourceMode: "branch",
      } as never),
    ).rejects.toThrow(/already exists/);
    expect(h.creates).toEqual([]);
  });

  it("carries the branch onto the new environment row", async () => {
    const { createProjectEnvironment } = await load();
    const env = await createProjectEnvironment("proj_prod", ctx, {
      environmentName: "Staging",
      gitBranch: "staging",
      sourceMode: "branch",
    } as never);

    expect(h.creates[0]!.gitBranch).toBe("staging");
    expect(h.creates[0]!.groupId).toBe("grp_1");
    expect(env.gitBranch).toBe("staging");
  });

  it("copies a release image's source and runtime class into a new environment", async () => {
    const releaseSource = {
      mode: "github",
      artifactKind: "image",
      repo: "acme/site",
      imageTemplate: "ghcr.io/acme/site:{tag}",
      pinnedVersion: "v2.0.0",
      trackReleases: true,
    };
    Object.assign(h.base, {
      gitProvider: "release",
      gitOwner: null,
      gitRepo: null,
      gitUrl: null,
      installationId: null,
      localPath: null,
      releaseSource,
      sourceKind: "image",
      buildKind: "prebuilt",
      runtimeMode: "docker",
      hasBuild: false,
      startCommand: null,
    });

    const { createProjectEnvironment } = await load();
    await createProjectEnvironment("proj_prod", ctx, {
      environmentName: "Staging",
      sourceMode: "branch",
    } as never);

    expect(h.creates).toHaveLength(1);
    expect(h.creates[0]).toMatchObject({
      gitProvider: "release",
      gitOwner: null,
      gitRepo: null,
      gitUrl: null,
      installationId: null,
      localPath: null,
      releaseSource,
      sourceKind: "image",
      buildKind: "prebuilt",
      runtimeMode: "docker",
      hasBuild: false,
      workloadType: "web",
      startCommand: null,
      // A new environment never inherits webhook bookkeeping.
      webhookId: null,
      webhookDomain: null,
    });
  });
});

describe("createProject — release image source", () => {
  beforeEach(() => {
    Object.assign(h.base, {
      gitProvider: "github",
      framework: "node",
      gitOwner: "acme",
      gitRepo: "site",
      gitUrl: "https://github.com/acme/site.git",
      installationId: 42,
      localPath: null,
      releaseSource: null,
      sourceKind: null,
      buildKind: null,
      runtimeMode: null,
      hasBuild: true,
      startCommand: "npm start",
      webhookId: 17,
      webhookDomain: "hooks.example.com",
      autoDeploy: true,
    });
    h.creates = [];
    h.groupCreates = [];
    h.siblings = [];
  });

  it("persists the complete source and freezes image/prebuilt/docker as one class", async () => {
    const releaseSource = {
      mode: "github",
      artifactKind: "image",
      repo: "acme/release-app",
      imageTemplate: "ghcr.io/acme/release-app:{tag}",
      pinnedVersion: "v3.4.5",
      trackReleases: true,
    };
    const { createProject } = await load();

    await createProject(
      {
        name: "Release App",
        gitProvider: "release",
        releaseSource,
        framework: "node",
        workloadType: "web",
        port: 8080,
      } as never,
      "org_1",
    );

    expect(h.groupCreates).toHaveLength(1);
    expect(h.creates).toHaveLength(1);
    expect(h.creates[0]).toMatchObject({
      gitProvider: "release",
      releaseSource,
      hasBuild: false,
      sourceKind: "image",
      buildKind: "prebuilt",
      runtimeMode: "docker",
      workloadType: "web",
      hasServer: true,
    });
    expect(h.creates[0]?.gitOwner).toBeUndefined();
    expect(h.creates[0]?.gitRepo).toBeUndefined();
    expect(h.creates[0]?.gitUrl).toBeUndefined();
    expect(h.creates[0]?.localPath).toBeUndefined();
  });

  it("normalizes only the supported release-source contract", async () => {
    const { createProject } = await load();

    await createProject(
      {
        name: "Normalized Release App",
        gitProvider: "release",
        releaseSource: {
          mode: "github",
          artifactKind: "image",
          repo: "  acme/release-app  ",
          imageTemplate: "  ghcr.io/acme/release-app:{tag}  ",
          pinnedVersion: "  v3.4.5  ",
          trackReleases: false,
          unrecognizedInternalField: "must-not-persist",
        },
        framework: "node",
        workloadType: "web",
      } as never,
      "org_1",
    );

    expect(h.creates[0]?.releaseSource).toEqual({
      mode: "github",
      artifactKind: "image",
      repo: "acme/release-app",
      imageTemplate: "ghcr.io/acme/release-app:{tag}",
      pinnedVersion: "v3.4.5",
      trackReleases: false,
    });
  });

  it("rejects an unsafe external version source before writing any rows", async () => {
    const { createProject } = await load();

    await expect(
      createProject(
        {
          name: "Unsafe Release App",
          gitProvider: "release",
          releaseSource: {
            mode: "url",
            artifactKind: "image",
            versionUrl: "http://metadata.internal/latest",
            imageTemplate: "registry.example.com/acme/app:{tag}",
          },
          framework: "node",
          workloadType: "web",
          port: 8080,
        } as never,
        "org_1",
      ),
    ).rejects.toThrow(/must use HTTPS/);

    expect(h.groupCreates).toHaveLength(0);
    expect(h.creates).toHaveLength(0);
  });

  it("rejects a pinned tag that cannot produce a valid image reference", async () => {
    const { createProject } = await load();

    await expect(
      createProject(
        {
          name: "Invalid Release App",
          gitProvider: "release",
          releaseSource: {
            mode: "url",
            artifactKind: "image",
            pinnedVersion: "release/1.2.3",
            imageTemplate: "registry.example.com/acme/app:{tag}",
          },
          framework: "node",
          workloadType: "web",
          port: 8080,
        } as never,
        "org_1",
      ),
    ).rejects.toThrow(/invalid/);

    expect(h.groupCreates).toHaveLength(0);
    expect(h.creates).toHaveLength(0);
  });

  it("rejects a services-class framework before writing any rows", async () => {
    const { createProject } = await load();

    await expect(
      createProject(
        {
          name: "Compose Release App",
          gitProvider: "release",
          releaseSource: {
            mode: "github",
            artifactKind: "image",
            repo: "acme/release-app",
            imageTemplate: "ghcr.io/acme/release-app:{tag}",
          },
          framework: "docker-compose",
          workloadType: "web",
          port: 8080,
        } as never,
        "org_1",
      ),
    ).rejects.toThrow(/individual services/);

    expect(h.groupCreates).toHaveLength(0);
    expect(h.creates).toHaveLength(0);
  });
});
