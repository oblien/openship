import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Renaming a project changes its DISPLAY NAME and nothing else.
 *
 * `updateProject` used to recompute `slug = slugify(name)` on every rename, and the
 * slug is this project's infrastructure identity — it names the `openship-<slug>`
 * network, the `openship-<slug>-<svc>` containers, the `openship-<slug>-<vol>` named
 * volumes, and the monorepo app row (matched by `service.name === project.slug`).
 * Two things broke at once:
 *
 *   1. the free `<slug>.opsh.io` hostname was rewritten and the old one
 *      deregistered, so a rename silently moved the project's LIVE public URL; and
 *   2. the running containers kept the OLD slug, so the next deploy recreated them
 *      under the new one against brand-new EMPTY volumes.
 *
 * The properties pinned here are what makes a rename safe: the patch carries `name`
 * and never `slug`, no route reconciliation is triggered, and an explicit `slug` in
 * the PATCH body is dropped (that path had no caller and no collision check). The
 * name-uniqueness 409 is kept — the slug namespace is still reserved per org.
 */

const h = vi.hoisted(() => ({
  project: {
    id: "proj_1",
    organizationId: "org_1",
    groupId: "grp_1",
    name: "Next Server Info",
    slug: "next-server-info",
    environmentSlug: "production",
    environmentName: "Production",
    internalAlias: null as string | null,
    gitProvider: "github",
    framework: "node",
    gitOwner: "acme" as string | null,
    gitRepo: "old-app" as string | null,
    gitBranch: "main",
    gitUrl: "https://github.com/acme/old-app.git" as string | null,
    installationId: 91 as number | null,
    localPath: "/srv/old-app" as string | null,
    releaseSource: null as Record<string, unknown> | null,
    sourceKind: null as string | null,
    buildKind: null as string | null,
    workloadType: "web",
    hasServer: true,
    hasBuild: true,
    runtimeMode: null as string | null,
    startCommand: "npm start" as string | null,
    composePath: "compose.yml" as string | null,
    webhookId: 77 as number | null,
    webhookDomain: "hooks.example.com" as string | null,
    autoDeploy: true,
    deletionInProgress: false,
    activeDeploymentId: null as string | null,
    serverId: null as string | null,
    resources: null,
    buildResources: null,
  },
  /** Another project in the org, holding the `taken` slug. */
  bySlug: {} as Record<string, { id: string } | undefined>,
  projectUpdates: [] as Array<Record<string, unknown>>,
  groupUpdates: [] as Array<Record<string, unknown>>,
  routeSyncs: [] as Array<Record<string, unknown>>,
  liveRouteReapplies: 0,
  sourceUpdates: [] as Array<{
    groupId: string;
    projectFields: Record<string, unknown>;
    groupFields: Record<string, unknown>;
  }>,
  ensureSharedWebhook: vi.fn(async () => null as number | null),
}));

vi.mock("@repo/db", () => ({
  repos: {
    project: {
      findById: async () => ({ ...h.project }),
      update: async (_id: string, patch: Record<string, unknown>) => {
        h.projectUpdates.push(patch);
        Object.assign(h.project, patch);
      },
      updateSourceByApp: async (
        groupId: string,
        projectFields: Record<string, unknown>,
        groupFields: Record<string, unknown>,
      ) => {
        h.sourceUpdates.push({ groupId, projectFields, groupFields });
        Object.assign(h.project, projectFields);
      },
      findBySlugInOrg: async (_org: string, slug: string) => h.bySlug[slug] ?? null,
      listByGroup: async () => [{ ...h.project }],
    },
    projectGroup: {
      update: async (_id: string, patch: Record<string, unknown>) => {
        h.groupUpdates.push(patch);
      },
      findBySlugInOrg: async () => null,
      findById: async () => ({ id: "grp_1", name: h.project.name, slug: h.project.slug }),
    },
    deployment: { findById: async () => null },
    service: { listByProject: async () => [] },
    domain: { listByProject: async () => [] },
    server: { getInOrganization: async () => null },
    // `enrichProject` runs on the way out of a rename and asks whether the project has a live
    // migration (the field every status pill reads). Declared so these tests exercise the real
    // lookup — the service also survives its absence, but by logging and reporting "no
    // migration", which is not the path a rename test should be silently taking.
    dockerMigrationRun: { findActiveForProject: async () => null },
  },
}));

/**
 * The route layer is the seam that proves property 1: a rename must not reach it at
 * all. Its own contract (how a slug change rewrites and deregisters hostnames) lives
 * with the domains module — here we only assert it is never invoked.
 */
vi.mock("../domains/project-route.service", () => ({
  syncProjectRouteState: async (_p: unknown, input: Record<string, unknown>) => {
    h.routeSyncs.push(input);
  },
  reapplyProjectLiveRoutes: async () => {
    h.liveRouteReapplies += 1;
  },
  resolveProjectRouteState: async () => ({ projectDomains: [], publicEndpoints: [] }),
  listProjectRouteRows: async () => [],
  persistProjectRouteState: async () => {},
  deriveNextProjectRouteState: () => ({ projectDomains: [], publicEndpoints: [] }),
  deriveEnvironmentPublicEndpoints: () => [],
}));

vi.mock("../domains/routing-apply.service", () => ({ applyProjectRouting: async () => {} }));
vi.mock("./project-runtime.service", () => ({ syncProjectManagedEdge: async () => {} }));
vi.mock("../../lib/free-domain-guard", () => ({ assertFreeEndpointsAllowed: async () => {} }));
vi.mock("../../lib/controller-helpers", () => ({
  assertResourceInOrg: () => {},
  platform: () => ({ runtime: { name: "docker" } }),
}));
vi.mock("../github/github.service", () => ({
  resolveDefaultBranch: async () => "main",
  listBranches: async () => [],
  getLatestCommit: async () => null,
  resolveWebhookStrategy: async () => "none",
}));
vi.mock("../github/github.auth", () => ({
  getInstallationIdByOrg: async () => undefined,
  getInstallUrl: () => "",
}));
vi.mock("./project-git-webhook", () => ({
  ensureSharedWebhook: h.ensureSharedWebhook,
  findSharedWebhookId: async () => null,
}));
vi.mock("../../lib/project-runtime-lock", () => ({
  withLiveProjectRuntimeMutation: async (
    _projectId: string,
    mutate: (project: typeof h.project) => Promise<unknown>,
  ) => (h.project.deletionInProgress ? undefined : mutate({ ...h.project })),
}));
vi.mock("../../lib/release-resolver", () => ({
  resolveLatestVersion: async () => null,
  resolveLatestReleaseTag: async () => null,
  readApiVersion: () => "0.0.0",
}));
vi.mock("../../lib/image-registry", () => ({ resolveLatestImageDigest: async () => null }));
vi.mock("./folder/session-store", () => ({ getFolderSession: () => null }));
vi.mock("../../config", () => ({ env: { CLOUD_MODE: false, CLOUD_MAX_PROJECTS_PER_USER: 2 } }));

const load = () => import("./project-crud.service");

describe("project rename — the slug is immutable", () => {
  beforeEach(() => {
    h.project.name = "Next Server Info";
    h.project.slug = "next-server-info";
    h.bySlug = {};
    h.projectUpdates = [];
    h.groupUpdates = [];
    h.routeSyncs = [];
    h.liveRouteReapplies = 0;
    h.sourceUpdates = [];
    h.project.deletionInProgress = false;
    Object.assign(h.project, {
      gitProvider: "github",
      framework: "node",
      gitOwner: "acme",
      gitRepo: "old-app",
      gitBranch: "main",
      gitUrl: "https://github.com/acme/old-app.git",
      installationId: 91,
      localPath: "/srv/old-app",
      releaseSource: null,
      sourceKind: null,
      buildKind: null,
      workloadType: "web",
      hasServer: true,
      hasBuild: true,
      runtimeMode: null,
      startCommand: "npm start",
      composePath: "compose.yml",
      webhookId: 77,
      webhookDomain: "hooks.example.com",
      autoDeploy: true,
    });
  });

  it("writes the new name and leaves the slug alone", async () => {
    const { updateProject } = await load();
    await updateProject("proj_1", { name: "Marketing Site" } as never, "org_1");

    const patch = h.projectUpdates.at(0) ?? {};
    expect(patch.name).toBe("Marketing Site");
    expect(patch).not.toHaveProperty("slug");
    expect(h.project.slug).toBe("next-server-info");
  });

  it("does not reconcile routes — the live *.opsh.io hostname stays put", async () => {
    const { updateProject } = await load();
    await updateProject("proj_1", { name: "Marketing Site" } as never, "org_1");

    expect(h.routeSyncs).toEqual([]);
  });

  it("drops an explicit slug in the PATCH body", async () => {
    const { updateProject } = await load();
    await updateProject(
      "proj_1",
      { name: "Marketing Site", slug: "marketing-site" } as never,
      "org_1",
    );

    for (const patch of h.projectUpdates) expect(patch).not.toHaveProperty("slug");
    expect(h.project.slug).toBe("next-server-info");
    expect(h.routeSyncs).toEqual([]);
  });

  it("fans the name out to the group row, but never the group slug", async () => {
    const { updateProject } = await load();
    await updateProject("proj_1", { name: "Marketing Site" } as never, "org_1");

    expect(h.groupUpdates).toEqual([{ name: "Marketing Site" }]);
  });

  it("still 409s when the name's slug belongs to another project", async () => {
    h.bySlug["marketing-site"] = { id: "proj_2" };
    const { updateProject } = await load();

    await expect(
      updateProject("proj_1", { name: "Marketing Site" } as never, "org_1"),
    ).rejects.toThrow(/already exists/i);
    expect(h.projectUpdates).toEqual([]);
  });

  it("allows a rename whose slug is this project's own", async () => {
    h.bySlug["next-server-info-staging"] = { id: "proj_1" };
    const { updateProject } = await load();

    await updateProject("proj_1", { name: "Next Server Info Staging" } as never, "org_1");
    expect(h.projectUpdates.at(0)?.name).toBe("Next Server Info Staging");
  });
});

describe("project source transitions", () => {
  beforeEach(() => {
    h.projectUpdates = [];
    h.sourceUpdates = [];
    Object.assign(h.project, {
      gitProvider: "github",
      gitOwner: "acme",
      gitRepo: "old-app",
      gitBranch: "main",
      gitUrl: "https://github.com/acme/old-app.git",
      installationId: 91,
      localPath: "/srv/old-app",
      releaseSource: null,
      sourceKind: null,
      buildKind: null,
      workloadType: "web",
      hasServer: true,
      hasBuild: true,
      runtimeMode: null,
      startCommand: "npm start",
      composePath: null,
      webhookId: 77,
      webhookDomain: "hooks.example.com",
      autoDeploy: true,
    });
  });

  it("sets the full release source and clears stale Git/local/process identity atomically", async () => {
    const releaseSource = {
      mode: "github",
      artifactKind: "image",
      repo: "acme/release-app",
      imageTemplate: "ghcr.io/acme/release-app:{tag}",
      pinnedVersion: "v2.3.4",
      trackReleases: true,
    };
    const { setProjectReleaseImageSource } = await load();

    await setProjectReleaseImageSource("proj_1", "org_1", releaseSource as never);

    expect(h.sourceUpdates).toHaveLength(1);
    expect(h.sourceUpdates[0]).toEqual({
      groupId: "grp_1",
      projectFields: {
        gitProvider: "release",
        gitOwner: null,
        gitRepo: null,
        gitUrl: null,
        installationId: null,
        localPath: null,
        releaseSource,
        sourceKind: "image",
        buildKind: "prebuilt",
        hasBuild: false,
        runtimeMode: "docker",
        startCommand: null,
        composePath: null,
        webhookId: null,
        webhookDomain: null,
        autoDeploy: false,
      },
      groupFields: {
        gitProvider: "release",
        gitOwner: null,
        gitRepo: null,
        gitUrl: null,
        installationId: null,
      },
    });
  });

  it("preserves intentional command overrides when editing an existing image source", async () => {
    const previousSource = {
      mode: "github",
      artifactKind: "image",
      repo: "acme/release-app",
      imageTemplate: "ghcr.io/acme/release-app:{tag}",
      pinnedVersion: "v2.3.4",
    };
    Object.assign(h.project, {
      gitProvider: "release",
      releaseSource: previousSource,
      sourceKind: "image",
      buildKind: "prebuilt",
      hasBuild: false,
      runtimeMode: "docker",
      startCommand: "./serve --foreground",
    });
    const nextSource = { ...previousSource, pinnedVersion: "v2.4.0" };
    const { setProjectReleaseImageSource } = await load();

    await setProjectReleaseImageSource("proj_1", "org_1", nextSource as never);

    expect(h.sourceUpdates).toHaveLength(1);
    expect(h.sourceUpdates[0]?.projectFields.releaseSource).toEqual(nextSource);
    expect(h.sourceUpdates[0]?.projectFields).not.toHaveProperty("startCommand");
  });

  it("rejects a services-class framework before changing source identity", async () => {
    Object.assign(h.project, { framework: "docker-compose", composePath: null });
    const { setProjectReleaseImageSource } = await load();

    await expect(
      setProjectReleaseImageSource("proj_1", "org_1", {
        mode: "github",
        artifactKind: "image",
        repo: "acme/release-app",
        imageTemplate: "ghcr.io/acme/release-app:{tag}",
      } as never),
    ).rejects.toThrow(/multiple services/);

    expect(h.sourceUpdates).toHaveLength(0);
  });

  it("does not let generic PATCH mutate releaseSource", async () => {
    const { updateProject } = await load();
    const attempted = {
      mode: "github",
      artifactKind: "image",
      repo: "evil/repoint",
      imageTemplate: "ghcr.io/evil/repoint:{tag}",
      pinnedVersion: "v9.9.9",
    };

    await updateProject("proj_1", { releaseSource: attempted } as never, "org_1");

    expect(h.project.releaseSource).toBeNull();
    expect(h.projectUpdates).toHaveLength(1);
    expect(h.projectUpdates[0]).not.toHaveProperty("releaseSource");
  });

  it("linking Git clears the release-image class before adopting the repository", async () => {
    Object.assign(h.project, {
      gitProvider: "release",
      gitOwner: null,
      gitRepo: null,
      gitUrl: null,
      installationId: null,
      localPath: null,
      releaseSource: {
        mode: "github",
        artifactKind: "image",
        repo: "acme/release-app",
        imageTemplate: "ghcr.io/acme/release-app:{tag}",
        pinnedVersion: "v2.3.4",
      },
      sourceKind: "image",
      buildKind: "prebuilt",
      hasBuild: false,
      runtimeMode: "docker",
      startCommand: "/app/run-release",
    });
    const { linkProjectRepo } = await load();

    await expect(
      linkProjectRepo({ userId: "user_1", organizationId: "org_1" } as never, "proj_1", {
        owner: "acme",
        repo: "source-app",
        branch: "main",
      }),
    ).resolves.toMatchObject({ ok: true, owner: "acme", repo: "source-app", branch: "main" });

    expect(h.sourceUpdates).toHaveLength(1);
    expect(h.sourceUpdates[0]?.projectFields).toMatchObject({
      gitProvider: "github",
      gitOwner: "acme",
      gitRepo: "source-app",
      gitUrl: "https://github.com/acme/source-app.git",
      releaseSource: null,
      localPath: null,
      sourceKind: null,
      buildKind: null,
      hasBuild: true,
      runtimeMode: null,
      startCommand: null,
      webhookId: null,
      autoDeploy: false,
    });
    expect(h.sourceUpdates[0]?.projectFields).not.toHaveProperty("webhookDomain");
    expect(h.projectUpdates).toContainEqual({ gitBranch: "main" });
  });

  it("does not reset build/runtime settings when relinking an ordinary project", async () => {
    Object.assign(h.project, {
      gitProvider: "github",
      localPath: null,
      releaseSource: null,
      sourceKind: "git",
      buildKind: "dockerfile",
      hasBuild: false,
      runtimeMode: "docker",
      startCommand: "./custom-start",
    });
    const { linkProjectRepo } = await load();

    await linkProjectRepo({ userId: "user_1", organizationId: "org_1" } as never, "proj_1", {
      owner: "acme",
      repo: "new-source",
      branch: "main",
    });

    expect(h.sourceUpdates).toHaveLength(1);
    const fields = h.sourceUpdates[0]!.projectFields;
    expect(fields).toMatchObject({
      gitProvider: "github",
      gitOwner: "acme",
      gitRepo: "new-source",
      releaseSource: null,
      localPath: null,
      sourceKind: null,
    });
    expect(fields).not.toHaveProperty("buildKind");
    expect(fields).not.toHaveProperty("hasBuild");
    expect(fields).not.toHaveProperty("runtimeMode");
    expect(fields).not.toHaveProperty("startCommand");
  });

  it("does not register a webhook or repoint source after deletion claims the project", async () => {
    h.project.deletionInProgress = true;
    const { linkProjectRepo } = await load();

    await expect(
      linkProjectRepo({ userId: "user_1", organizationId: "org_1" } as never, "proj_1", {
        owner: "acme",
        repo: "new-source",
        branch: "main",
      }),
    ).resolves.toEqual({ ok: false, code: "not_found" });

    expect(h.ensureSharedWebhook).not.toHaveBeenCalled();
    expect(h.sourceUpdates).toEqual([]);
    expect(h.projectUpdates).toEqual([]);
  });
});
