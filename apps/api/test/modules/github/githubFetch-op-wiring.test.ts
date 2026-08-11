import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * githubFetch funnel-wiring regression for GHSA-hp2g-hw7g-f3vm — the OTHER half.
 *
 * `githubFetch` is the single HTTP wrapper every github.service mutation routes
 * through. The advisory's defect lived HERE: it called `tokenFor` with neither
 * the repo nor an operation, so the mint gate ran owner-wide at "read" for a
 * DELETE/POST. A read grant on one repo then minted the org App token for a
 * write on any repo under the same owner.
 *
 * The refactor that pre-dated the fix even plumbed `repo` through `TokenContext`
 * — but `githubFetch` never POPULATED it, so the plumbing was dead and the hole
 * stayed open. These tests pin the population itself: a non-GET threads
 * op:"write" + the repo into `tokenFor`; a GET threads op:"read". A revert that
 * drops either re-opens the CVE and fails here.
 *
 * github.auth.ts statically imports the better-auth stack (`../../lib/auth`),
 * so every static import is mocked to keep the module loadable in isolation;
 * `tokenFor` (dynamically imported inside githubFetch) is the spy under test.
 */

const { tokenForSpy, ghFetchSpy, ghFetchPublicSpy, getLocalGhToken } = vi.hoisted(() => ({
  tokenForSpy: vi.fn(),
  ghFetchSpy: vi.fn(),
  ghFetchPublicSpy: vi.fn(),
  getLocalGhToken: vi.fn(),
}));

// ── Neutralize github.auth.ts's static imports (keep the auth stack out) ──
vi.mock("@repo/db", () => ({ repos: {}, db: {}, schema: {}, eq: vi.fn(), and: vi.fn() }));
vi.mock("better-auth/api", () => ({ APIError: class APIError extends Error {} }));
vi.mock("../../../src/config/env", () => ({ env: {} }));
vi.mock("../../../src/lib/auth", () => ({ auth: {} }));
vi.mock("../../../src/lib/cache-store", () => ({ cacheStore: vi.fn() }));
vi.mock("../../../src/lib/org-actor", () => ({ resolveOrgOwner: vi.fn() }));
vi.mock("../../../src/modules/github/sources/mappers", () => ({ mapAccounts: vi.fn() }));
vi.mock("../../../src/modules/github/github.http", () => ({
  ghFetch: ghFetchSpy,
  ghFetchPublic: ghFetchPublicSpy,
}));
// ── The two dynamically-imported modules inside githubFetch ──
vi.mock("../../../src/modules/github/github.local-auth", () => ({ getLocalGhToken }));
vi.mock("../../../src/modules/github/github.token", () => ({ tokenFor: tokenForSpy }));

import { githubFetch } from "../../../src/modules/github/github.auth";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ctx = { userId: "u1", organizationId: "o1" } as any;

beforeEach(() => {
  vi.clearAllMocks();
  getLocalGhToken.mockResolvedValue(null); // no local gh → GET falls through to tokenFor too
  tokenForSpy.mockResolvedValue({ token: "apptok", source: "app-installation" });
  ghFetchSpy.mockResolvedValue({ ok: true });
  ghFetchPublicSpy.mockResolvedValue(null);
});

describe("githubFetch — threads op + repo into tokenFor (GHSA-hp2g-hw7g-f3vm)", () => {
  it("a DELETE mints with op:'write' and the repo (the exact call the CVE abused)", async () => {
    await githubFetch({
      ctx,
      method: "DELETE",
      url: "https://api.github.com/repos/acme/production-api",
      owner: "acme",
      repo: "production-api",
    });
    expect(tokenForSpy).toHaveBeenCalledWith(
      ctx,
      "local",
      expect.objectContaining({ owner: "acme", repo: "production-api", op: "write" }),
    );
  });

  it.each(["POST", "PATCH", "PUT", "DELETE"] as const)(
    "%s is treated as a write",
    async (method) => {
      await githubFetch({
        ctx,
        method,
        url: "https://api.github.com/repos/acme/production-api/hooks",
        owner: "acme",
        repo: "production-api",
      });
      expect(tokenForSpy.mock.calls[0][2]).toMatchObject({ op: "write", repo: "production-api" });
    },
  );

  it("a GET is a read (op:'read') and still threads the repo", async () => {
    await githubFetch({
      ctx,
      method: "GET",
      url: "https://api.github.com/repos/acme/production-api",
      owner: "acme",
      repo: "production-api",
    });
    expect(tokenForSpy).toHaveBeenCalledWith(
      ctx,
      "local",
      expect.objectContaining({ owner: "acme", repo: "production-api", op: "read" }),
    );
  });

  it("defaults to GET/read when no method is given", async () => {
    await githubFetch({ ctx, url: "https://api.github.com/repos/acme/production-api", owner: "acme", repo: "production-api" });
    expect(tokenForSpy.mock.calls[0][2]).toMatchObject({ op: "read" });
  });

  it("authorizeAs overrides the method-derived tier for deploy-tier mutations", async () => {
    // A read-only deploy key and a check-run status post are POSTs that "may I
    // deploy this repo" authorizes. Without the override, minting a deploy key at
    // deploy time would demand a write grant and break read-grant deploys.
    await githubFetch({
      ctx,
      method: "POST",
      url: "https://api.github.com/repos/acme/production-api/keys",
      owner: "acme",
      repo: "production-api",
      authorizeAs: "read",
    });
    expect(tokenForSpy.mock.calls[0][2]).toMatchObject({ op: "read", repo: "production-api" });
  });

  it("authorizeAs does not let a management call widen itself by default", async () => {
    // No override → DELETE is still a write. Pinned so the escape hatch above
    // cannot quietly become the default.
    await githubFetch({
      ctx,
      method: "DELETE",
      url: "https://api.github.com/repos/acme/production-api/hooks/1",
      owner: "acme",
      repo: "production-api",
    });
    expect(tokenForSpy.mock.calls[0][2]).toMatchObject({ op: "write" });
  });

  it("when the gate denies the write (tokenFor → null), a mutating call NEVER hits the wire", async () => {
    tokenForSpy.mockResolvedValue(null);
    await expect(
      githubFetch({
        ctx,
        method: "DELETE",
        url: "https://api.github.com/repos/acme/production-api",
        owner: "acme",
        repo: "production-api",
      }),
    ).rejects.toThrow(/No GitHub access token/);
    // A denied write must not fall back to an unauthenticated public request.
    expect(ghFetchPublicSpy).not.toHaveBeenCalled();
    expect(ghFetchSpy).not.toHaveBeenCalled();
  });
});
