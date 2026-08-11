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
    internalAlias: null as string | null,
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
}));

vi.mock("@repo/db", () => ({
  repos: {
    project: {
      findById: async () => ({ ...h.project }),
      update: async (_id: string, patch: Record<string, unknown>) => {
        h.projectUpdates.push(patch);
        Object.assign(h.project, patch);
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
  resolveWebhookStrategy: async () => ({}),
}));
vi.mock("../github/github.auth", () => ({
  getInstallationIdByOrg: async () => undefined,
  getInstallUrl: () => "",
}));
vi.mock("./project-git-webhook", () => ({ ensureSharedWebhook: async () => null }));
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
