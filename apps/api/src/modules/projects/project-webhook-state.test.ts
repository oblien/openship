import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `resolveProjectWebhookState` — the ONE derivation of "is push auto-deploy
 * wired up?", shared by `GET /:id/git` (the Source tab) and `GET /:id/info`
 * (the payload the Overview renders).
 *
 * It exists because those two surfaces disagreed: the Overview read the Source
 * tab's slice, which is only fetched when that tab mounts (it also calls GitHub
 * for recent commits), so a project whose pushes were really deploying showed
 * "auto-deploy off" on every cold load. The properties pinned here are the ones
 * that made the two answers diverge:
 *
 *   - `autoDeploy` is the column `webhook-push.ts` gates on, so it is reported
 *     as-is and never inferred from webhook bookkeeping;
 *   - a webhook belongs to (owner, repo), so a SIBLING project in the org may
 *     hold the id — the delivery path is active either way;
 *   - "none" (no publicly reachable URL) can never report an active path;
 *   - under the GitHub App the installation IS the delivery path, so no
 *     per-repo webhook id is required.
 */

const h = vi.hoisted(() => ({
  strategy: "repo" as "app" | "domain" | "repo" | "none",
  /** A webhook id held by a SIBLING project on the same (owner, repo). */
  siblingWebhookId: null as number | null,
  installationId: undefined as string | undefined,
  sharedLookups: 0,
}));

vi.mock("@repo/db", () => ({
  repos: {
    project: { findById: async () => null, update: async () => {} },
    deployment: { findById: async () => null },
    service: { listByProject: async () => [] },
    domain: { listByProject: async () => [] },
    server: { getInOrganization: async () => null },
    dockerMigrationRun: { findActiveForProject: async () => null },
  },
}));

vi.mock("../domains/project-route.service", () => ({
  syncProjectRouteState: async () => {},
  reapplyProjectLiveRoutes: async () => {},
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
  listTags: async () => [],
  getLatestCommit: async () => null,
  getWebhookStrategy: () => h.strategy,
  resolveLatestMatchingTagCommit: async () => null,
  // The seam the state depends on: which delivery mechanism this instance can use.
  resolveWebhookStrategy: async () => h.strategy,
}));
vi.mock("../github/github.auth", () => ({
  getInstallationIdByOrg: async () => h.installationId,
  resolveInstallUrl: async () => ({ url: "", state: "" }),
}));
vi.mock("./project-git-webhook", () => ({
  ensureSharedWebhook: async () => null,
  findSharedWebhookId: async () => {
    h.sharedLookups += 1;
    return h.siblingWebhookId;
  },
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

const gitProject = {
  gitOwner: "acme",
  gitRepo: "app",
  webhookId: 4242 as number | null,
  webhookDomain: null as string | null,
  autoDeploy: true as boolean | null,
  deployTarget: "local" as string | null,
};

describe("resolveProjectWebhookState", () => {
  beforeEach(() => {
    h.strategy = "repo";
    h.siblingWebhookId = null;
    h.installationId = undefined;
    h.sharedLookups = 0;
  });

  it("reports an active delivery path for an enabled repo-strategy project", async () => {
    const { resolveProjectWebhookState } = await load();

    const state = await resolveProjectWebhookState("org_1", { ...gitProject });

    expect(state.strategy).toBe("repo");
    expect(state.webhookActive).toBe(true);
    expect(state.sharedWebhookId).toBe(4242);
    // The project's own column answered it — no org-wide lookup needed.
    expect(h.sharedLookups).toBe(0);
  });

  it("falls back to a sibling project's webhook id — the hook belongs to the repo", async () => {
    h.siblingWebhookId = 99;
    const { resolveProjectWebhookState } = await load();

    const state = await resolveProjectWebhookState("org_1", { ...gitProject, webhookId: null });

    expect(state.sharedWebhookId).toBe(99);
    expect(state.webhookActive).toBe(true);
    expect(h.sharedLookups).toBe(1);
  });

  it("reports no delivery path when auto-deploy is off", async () => {
    const { resolveProjectWebhookState } = await load();

    const state = await resolveProjectWebhookState("org_1", { ...gitProject, autoDeploy: false });

    expect(state.webhookActive).toBe(false);
  });

  it("never reports active under the 'none' strategy, hook or not", async () => {
    h.strategy = "none";
    const { resolveProjectWebhookState } = await load();

    const state = await resolveProjectWebhookState("org_1", { ...gitProject });

    expect(state.strategy).toBe("none");
    expect(state.webhookActive).toBe(false);
  });

  it("under the GitHub App the installation IS the delivery path — no repo hook needed", async () => {
    h.strategy = "app";
    h.installationId = "inst_1";
    const { resolveProjectWebhookState } = await load();

    const state = await resolveProjectWebhookState("org_1", {
      ...gitProject,
      webhookId: null,
      deployTarget: "cloud",
    });

    expect(state.installationInstalled).toBe(true);
    expect(state.webhookActive).toBe(true);
  });

  it("uses the local App delivery path for a local target too", async () => {
    h.strategy = "app";
    h.installationId = "inst_1";
    const { resolveProjectWebhookState } = await load();

    const state = await resolveProjectWebhookState("org_1", {
      ...gitProject,
      webhookId: null,
      deployTarget: "local",
    });

    expect(state.installationInstalled).toBe(true);
    expect(state.webhookActive).toBe(true);
    expect(state.sharedWebhookId).toBeNull();
  });

  it("app strategy with the App uninstalled reports no delivery path", async () => {
    h.strategy = "app";
    h.installationId = undefined;
    const { resolveProjectWebhookState } = await load();

    const state = await resolveProjectWebhookState("org_1", {
      ...gitProject,
      deployTarget: "cloud",
    });

    expect(state.installationInstalled).toBe(false);
    expect(state.webhookActive).toBe(false);
  });
});
