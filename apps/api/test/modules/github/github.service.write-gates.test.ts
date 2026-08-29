import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Endpoint-level write gates for GHSA-hp2g-hw7g-f3vm — the layer nothing else
 * tests, and the only layer that holds when the token funnel is bypassed.
 *
 * The funnel gate in `github.token.ts` protects the App-installation mint. It is
 * not the whole story: on a self-hosted instance the chain can answer with the
 * operator's gh-CLI token or a project clone token, and the four management
 * helpers below are reachable by a plain MEMBER because `github:admin` is no
 * higher a route bar than `github:read` (roleAllowsResourceType ignores the
 * action level for owner/admin/member). So each of these must refuse BEFORE any
 * credential is resolved — which is what these tests pin: the throw happens with
 * `githubFetch` never called.
 *
 * Only the DB is stubbed, so the REAL github-access rules run against REAL grant
 * rows — the helper, the gate and the grant matching are exercised together. A
 * test that stubbed the verdict function instead would pass with the gate deleted,
 * because `assertGitHubRepoAccess` calls `canUseGitHubRepo` through its own
 * module-internal binding, which a partial mock does not intercept.
 */

const { githubFetch, memberFind, listByMember } = vi.hoisted(() => ({
  githubFetch: vi.fn(),
  memberFind: vi.fn(),
  listByMember: vi.fn(),
}));

vi.mock("../../../src/modules/github/github.auth", () => ({
  githubFetch,
  getUserStatus: vi.fn(),
  getUserInstallations: vi.fn(),
  getInstallationIdByOrg: vi.fn(),
  mapAccounts: vi.fn(),
  getGitHubAuthMode: vi.fn(),
}));
vi.mock("../../../src/modules/github/github.local-auth", () => ({
  getLocalGhStatus: vi.fn(),
}));
vi.mock("../../../src/config/env", () => ({
  env: { GITHUB_WEBHOOK_SECRET: "envsecret" },
  runtimeTarget: { id: "local", dashboard: "http://localhost:3000" },
}));

// `grantSourceFor` returns repos.resourceGrant for a non-scoped caller, so these
// two lookups are the whole authorization input.
vi.mock("@repo/db", () => ({
  repos: {
    member: { find: memberFind },
    resourceGrant: { listByMember },
  },
}));

import {
  createRepository,
  deleteRepository,
  deleteWebhook,
  registerWebhook,
} from "../../../src/modules/github/github.service";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ctx = { userId: "m1", organizationId: "o1" } as any;

const repoGrant = (resourceId: string, ...permissions: string[]) => ({
  resourceType: "github_repository",
  resourceId,
  permissions,
});
const installationGrant = (resourceId: string, ...permissions: string[]) => ({
  resourceType: "github_installation",
  resourceId,
  permissions,
});

/** The advisory's attacker: a plain member, read-only on ONE unrelated repo. */
const READ_ON_MARKETING = [repoGrant("acme/marketing-site", "read")];

beforeEach(() => {
  vi.clearAllMocks();
  githubFetch.mockResolvedValue({ id: 1, events: [] });
  memberFind.mockResolvedValue({ role: "member" });
  listByMember.mockResolvedValue(READ_ON_MARKETING);
});

const denied = { statusCode: 403, code: "GITHUB_ACCESS_DENIED" };

describe("deleteRepository — per-repo write gate", () => {
  it("the advisory's exact call: read grant on repo A must not delete repo B", async () => {
    await expect(deleteRepository(ctx, "acme", "production-api")).rejects.toMatchObject(denied);
    expect(githubFetch).not.toHaveBeenCalled();
  });

  it("a read grant on THAT repo is still not enough to delete it", async () => {
    listByMember.mockResolvedValue([repoGrant("acme/production-api", "read")]);
    await expect(deleteRepository(ctx, "acme", "production-api")).rejects.toMatchObject(denied);
    expect(githubFetch).not.toHaveBeenCalled();
  });

  it("a WRITE grant on a sibling repo does not reach across", async () => {
    listByMember.mockResolvedValue([repoGrant("acme/marketing-site", "write")]);
    await expect(deleteRepository(ctx, "acme", "production-api")).rejects.toMatchObject(denied);
    expect(githubFetch).not.toHaveBeenCalled();
  });

  it("proceeds on a write grant for THIS repo, threading owner+repo into the fetch", async () => {
    listByMember.mockResolvedValue([repoGrant("acme/production-api", "write")]);
    await deleteRepository(ctx, "acme", "production-api");
    expect(githubFetch).toHaveBeenCalledWith(
      expect.objectContaining({ owner: "acme", repo: "production-api", method: "DELETE" }),
    );
  });

  it("proceeds for the org owner (auto-access, no grants)", async () => {
    memberFind.mockResolvedValue({ role: "owner" });
    listByMember.mockResolvedValue([]);
    await deleteRepository(ctx, "acme", "production-api");
    expect(githubFetch).toHaveBeenCalledTimes(1);
  });
});

describe("deleteWebhook — per-repo write gate", () => {
  it("refuses a read-grant member before any GitHub call", async () => {
    await expect(deleteWebhook(ctx, "acme", "production-api", 7)).rejects.toMatchObject(denied);
    expect(githubFetch).not.toHaveBeenCalled();
  });

  it("proceeds on a write grant for that repo", async () => {
    listByMember.mockResolvedValue([repoGrant("acme/production-api", "write")]);
    await deleteWebhook(ctx, "acme", "production-api", 7);
    expect(githubFetch).toHaveBeenCalledWith(
      expect.objectContaining({ owner: "acme", repo: "production-api", method: "DELETE" }),
    );
  });
});

describe("registerWebhook — per-repo write gate", () => {
  it("refuses a read-grant member before any GitHub call", async () => {
    await expect(
      registerWebhook(ctx, "acme", "production-api", "https://hooks.example/x"),
    ).rejects.toMatchObject(denied);
    expect(githubFetch).not.toHaveBeenCalled();
  });

  it("proceeds on a write grant for that repo", async () => {
    listByMember.mockResolvedValue([repoGrant("acme/production-api", "write")]);
    githubFetch.mockResolvedValue({ id: 42, events: ["push"] });
    await expect(
      registerWebhook(ctx, "acme", "production-api", "https://hooks.example/x"),
    ).resolves.toMatchObject({ hookId: 42 });
  });
});

describe("createRepository — owner-level AUTHORITY gate", () => {
  it("one repo write grant is NOT authority to add repos to the account", async () => {
    listByMember.mockResolvedValue([repoGrant("acme/marketing-site", "write")]);
    await expect(createRepository(ctx, "new-repo", { owner: "acme" })).rejects.toMatchObject(
      denied,
    );
    expect(githubFetch).not.toHaveBeenCalled();
  });

  it("an installation-level write grant IS", async () => {
    listByMember.mockResolvedValue([installationGrant("acme", "write")]);
    await createRepository(ctx, "new-repo", { owner: "acme" });
    expect(githubFetch).toHaveBeenCalledWith(
      expect.objectContaining({ url: "https://api.github.com/orgs/acme/repos", method: "POST" }),
    );
  });

  it("does not org-gate a repo under the caller's OWN account (their own credential)", async () => {
    listByMember.mockResolvedValue([]);
    await createRepository(ctx, "my-repo");
    expect(githubFetch).toHaveBeenCalledWith(
      expect.objectContaining({ url: "https://api.github.com/user/repos", method: "POST" }),
    );
  });
});
