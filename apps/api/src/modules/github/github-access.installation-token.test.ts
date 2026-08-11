import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `POST /api/cloud/github/installation-token` mints a live GitHub App installation
 * token. Its route tag (`cloud:write`) does NOT authorize it: "cloud" is an org
 * SINGLETON resource, so the permission assert runs with resourceId "*" and
 * `roleAllowsResourceType` lets a plain `member` through. Before this gate existed,
 * any org member could mint a token and the grant system that decides which repos a
 * member may touch was never consulted.
 *
 * What is pinned here is the MAPPING, because that is where the risk actually lives:
 *
 *   named repos → the returned token is scoped to exactly those, so each is
 *                 authorized at REPO level;
 *   no repos    → the token covers every repo in the installation, so the question
 *                 is owner-level AUTHORITY. Asking at the default "reach" level
 *                 would let a read grant on one repo under `acme` mint a token over
 *                 every repo under `acme` — the GHSA-qv27-39pc-qw9f finding-2 shape
 *                 arriving through a different door.
 *
 * Tested here rather than through the handler because cloud-saas.controller.ts pulls
 * in Better Auth and the whole SaaS graph, while the decision is this one function.
 * Mock shape matches github-access.write-escalation.test.ts.
 */

const { memberFind, listByMember } = vi.hoisted(() => ({
  memberFind: vi.fn(),
  listByMember: vi.fn(),
}));

vi.mock("@repo/db", () => ({
  repos: {
    member: { find: memberFind },
    resourceGrant: { listByMember },
  },
}));

import { canMintInstallationToken } from "./github-access";

// A plain member, not a scoped token: owner auto-access does not apply, so grant
// matching actually runs.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const memberCtx = { userId: "m1", organizationId: "o1" } as any;

const grant = (resourceType: string, resourceId: string, permissions: string[]) => ({
  resourceType,
  resourceId,
  permissions,
});

describe("canMintInstallationToken", () => {
  beforeEach(() => {
    memberFind.mockReset();
    listByMember.mockReset();
    memberFind.mockResolvedValue({ role: "member" });
    listByMember.mockResolvedValue([]);
  });

  it("refuses an un-narrowed token when the member only has ONE repo under the owner", async () => {
    // The core case. A read grant on acme/one is not authority over acme.
    listByMember.mockResolvedValue([grant("github_repository", "acme/one", ["read"])]);

    await expect(canMintInstallationToken(memberCtx, "acme")).resolves.toBe(false);
    await expect(canMintInstallationToken(memberCtx, "acme", [])).resolves.toBe(false);
  });

  it("allows an un-narrowed token for an installation-level grant", async () => {
    listByMember.mockResolvedValue([grant("github_installation", "acme", ["read"])]);
    await expect(canMintInstallationToken(memberCtx, "acme")).resolves.toBe(true);
  });

  it("allows a narrowed token for exactly the granted repo", async () => {
    listByMember.mockResolvedValue([grant("github_repository", "acme/one", ["read"])]);
    await expect(canMintInstallationToken(memberCtx, "acme", ["one"])).resolves.toBe(true);
  });

  it("refuses when ANY requested repo is ungranted (all-or-nothing)", async () => {
    // A token narrowed to [one, two] still reaches `two`, so partial access must not
    // be enough — the caller would otherwise get a working token for a repo they
    // cannot touch.
    listByMember.mockResolvedValue([grant("github_repository", "acme/one", ["read"])]);
    await expect(canMintInstallationToken(memberCtx, "acme", ["one", "two"])).resolves.toBe(false);
  });

  it("refuses a sibling repo under the same owner", async () => {
    listByMember.mockResolvedValue([grant("github_repository", "acme/one", ["read"])]);
    await expect(canMintInstallationToken(memberCtx, "acme", ["two"])).resolves.toBe(false);
  });

  it("treats whitespace-only repos as un-narrowed, not as nothing-to-check", async () => {
    // `[" "]` must NOT read as "no repos requested, so vacuously allowed". It falls
    // back to the stricter owner-authority question.
    listByMember.mockResolvedValue([grant("github_repository", "acme/one", ["read"])]);
    await expect(canMintInstallationToken(memberCtx, "acme", ["   "])).resolves.toBe(false);

    listByMember.mockResolvedValue([grant("github_installation", "acme", ["read"])]);
    await expect(canMintInstallationToken(memberCtx, "acme", ["   "])).resolves.toBe(true);
  });

  it("still allows the org owner (auto-access), narrowed or not", async () => {
    memberFind.mockResolvedValue({ role: "owner" });
    listByMember.mockResolvedValue([]);
    await expect(canMintInstallationToken(memberCtx, "acme")).resolves.toBe(true);
    await expect(canMintInstallationToken(memberCtx, "acme", ["anything"])).resolves.toBe(true);
  });

  it("refuses a non-member of the org", async () => {
    memberFind.mockResolvedValue(null);
    await expect(canMintInstallationToken(memberCtx, "acme")).resolves.toBe(false);
    await expect(canMintInstallationToken(memberCtx, "acme", ["one"])).resolves.toBe(false);
  });

  it("fails closed when the grant lookup throws", async () => {
    listByMember.mockRejectedValue(new Error("db down"));
    await expect(canMintInstallationToken(memberCtx, "acme")).resolves.toBe(false);
    await expect(canMintInstallationToken(memberCtx, "acme", ["one"])).resolves.toBe(false);
  });
});
