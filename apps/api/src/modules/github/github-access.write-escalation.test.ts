import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Regression for GHSA-hp2g-hw7g-f3vm — GitHub repo management was authorized
 * read-level and owner-wide, letting a non-owner member with a *read-only* grant
 * on ONE repo perform write/admin operations (delete/create repo, register/delete
 * webhooks) on ANY repo under the same owner via the org App installation token.
 *
 * Two defects fed the same token funnel:
 *   1. the operation was hardcoded to "read" regardless of HTTP method, so a read
 *      grant satisfied a DELETE/POST; and
 *   2. `repo` was dropped, so a grant on repo A satisfied an owner-wide check that
 *      then authorized repo B.
 *
 * These tests pin the authorization core (`canUseGitHubRepo`, github-access.ts)
 * that both defects violated — a read grant must never satisfy a write, and a
 * per-repo grant must never reach a sibling. The token funnel (github.token.ts /
 * github.auth.ts) now threads the real op + repo INTO this function; see
 * `test/modules/github/tokenFor-op-wiring.test.ts` for that wiring.
 */

const { memberFind, listByMember } = vi.hoisted(() => ({
  memberFind: vi.fn(),
  listByMember: vi.fn(),
}));

vi.mock("@repo/db", () => ({
  repos: {
    member: { find: memberFind },
    // grantSourceFor(ctx) returns repos.resourceGrant for a non-scoped caller.
    resourceGrant: { listByMember },
  },
}));

import { canUseGitHubRepo } from "./github-access";

// A plain (non-owner) member on org o1, NOT a scoped token → owner-auto-access
// only applies to the owner role, so grant matching actually runs.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const memberCtx = { userId: "m1", organizationId: "o1" } as any;

beforeEach(() => {
  vi.clearAllMocks();
  memberFind.mockResolvedValue({ role: "member" });
  // Read-only grant on exactly ONE repo under `acme`.
  listByMember.mockResolvedValue([
    {
      resourceType: "github_repository",
      resourceId: "acme/marketing-site",
      permissions: ["read"],
    },
  ]);
});

describe("canUseGitHubRepo — GHSA-hp2g-hw7g-f3vm write escalation", () => {
  it("allows READ on the exact granted repo (the legitimate case)", async () => {
    expect(
      await canUseGitHubRepo(memberCtx, { owner: "acme", repo: "marketing-site" }, "read"),
    ).toBe(true);
  });

  it("DENIES write on the granted repo when the grant is read-only (defect 1: op level)", async () => {
    expect(
      await canUseGitHubRepo(memberCtx, { owner: "acme", repo: "marketing-site" }, "write"),
    ).toBe(false);
  });

  it("DENIES write on a SIBLING repo under the same owner (defect 2: per-repo)", async () => {
    expect(
      await canUseGitHubRepo(memberCtx, { owner: "acme", repo: "production-api" }, "write"),
    ).toBe(false);
  });

  it("DENIES an owner-level write (repo omitted) — the exact call the pre-fix funnel made for a DELETE", async () => {
    // Pre-fix, the funnel called canUseGitHubRepo(ctx, {owner, repo: undefined}, "read")
    // for EVERY method; the read grant satisfied it owner-wide and minted the App
    // token. With the op corrected to "write", a read grant can no longer pass.
    expect(await canUseGitHubRepo(memberCtx, { owner: "acme" }, "write")).toBe(false);
  });

  it("still ALLOWS write when the member holds a WRITE grant on that repo", async () => {
    listByMember.mockResolvedValue([
      {
        resourceType: "github_repository",
        resourceId: "acme/production-api",
        permissions: ["write"],
      },
    ]);
    expect(
      await canUseGitHubRepo(memberCtx, { owner: "acme", repo: "production-api" }, "write"),
    ).toBe(true);
  });

  it("still DENIES a write grant on repo A from reaching sibling repo B", async () => {
    listByMember.mockResolvedValue([
      {
        resourceType: "github_repository",
        resourceId: "acme/marketing-site",
        permissions: ["write"],
      },
    ]);
    expect(
      await canUseGitHubRepo(memberCtx, { owner: "acme", repo: "production-api" }, "write"),
    ).toBe(false);
  });

  it("still ALLOWS the org OWNER (auto-access) to write any repo", async () => {
    memberFind.mockResolvedValue({ role: "owner" });
    listByMember.mockResolvedValue([]);
    expect(
      await canUseGitHubRepo(memberCtx, { owner: "acme", repo: "production-api" }, "write"),
    ).toBe(true);
  });

  it("honors an installation-level (owner-wide) grant for writes across repos", async () => {
    listByMember.mockResolvedValue([
      { resourceType: "github_installation", resourceId: "acme", permissions: ["write"] },
    ]);
    expect(
      await canUseGitHubRepo(memberCtx, { owner: "acme", repo: "production-api" }, "write"),
    ).toBe(true);
  });
});

/**
 * The `ownerLevel` mode is the only behavioural change inside this module, and it
 * only bites when `repo` is omitted — so the cases above (all repo-specific, all
 * 3-arg) would pass against the pre-fix module too. These are the ones that pin it.
 */
describe("canUseGitHubRepo — owner-level checks: reach vs authority", () => {
  beforeEach(() => {
    // One WRITE grant on one repo under `acme`. Enough to write THAT repo; the
    // question here is what it implies about the ACCOUNT.
    listByMember.mockResolvedValue([
      {
        resourceType: "github_repository",
        resourceId: "acme/marketing-site",
        permissions: ["write"],
      },
    ]);
  });

  it("'reach' (default) lets one granted repo satisfy an owner-level check", async () => {
    // Correct where the answer is narrowed downstream — list filtering, the picker.
    expect(await canUseGitHubRepo(memberCtx, { owner: "acme" }, "read")).toBe(true);
  });

  it("'authority' does NOT — one repo is not authority over the account", async () => {
    expect(
      await canUseGitHubRepo(memberCtx, { owner: "acme" }, "write", {
        ownerLevel: "authority",
      }),
    ).toBe(false);
  });

  it("'authority' passes on an installation-level grant", async () => {
    listByMember.mockResolvedValue([
      { resourceType: "github_installation", resourceId: "acme", permissions: ["write"] },
    ]);
    expect(
      await canUseGitHubRepo(memberCtx, { owner: "acme" }, "write", {
        ownerLevel: "authority",
      }),
    ).toBe(true);
  });

  it("'authority' passes on an all-GitHub grant", async () => {
    listByMember.mockResolvedValue([
      { resourceType: "github", resourceId: "*", permissions: ["write"] },
    ]);
    expect(
      await canUseGitHubRepo(memberCtx, { owner: "acme" }, "write", {
        ownerLevel: "authority",
      }),
    ).toBe(true);
  });

  it("'authority' is irrelevant once a repo is named (the repo match decides)", async () => {
    expect(
      await canUseGitHubRepo(memberCtx, { owner: "acme", repo: "marketing-site" }, "write", {
        ownerLevel: "authority",
      }),
    ).toBe(true);
  });
});
