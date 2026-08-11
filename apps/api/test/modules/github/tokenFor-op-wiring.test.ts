import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Funnel-wiring regression for GHSA-hp2g-hw7g-f3vm.
 *
 * `tokenFor` → `chainCtx` is THE gate every GitHub App token mint passes
 * through. The advisory's first defect was that this gate hardcoded the
 * operation to "read" and dropped the repo, so a mutating mint (DELETE repo,
 * POST webhook) cleared a *read-only* grant, and a grant on one repo satisfied
 * an owner-wide check that then authorized a sibling repo.
 *
 * The authorization logic itself (`canUseGitHubRepo`) was correct; the bug was
 * the ARGUMENTS the funnel fed it. These tests mock `canUseGitHubRepo` and
 * assert the exact `(target, op)` the funnel passes — the thing the fix changed
 * (`tokenCtx.op ?? "read"` and `repo: tokenCtx.repo` in `chainCtx`). A revert to
 * the hardcoded "read" / dropped-repo shape fails here.
 *
 * See `src/modules/github/github-access.write-escalation.test.ts` for the
 * companion test that pins the authorization core these args flow into.
 */

const { envMock, findProjectById, findSettingsByUser, decrypt, ghAuth, canUseGitHubRepo, getLocalGhToken } =
  vi.hoisted(() => ({
    envMock: { CLOUD_MODE: false, GITHUB_AUTH_MODE: undefined } as {
      CLOUD_MODE: boolean;
      GITHUB_AUTH_MODE?: string;
    },
    findProjectById: vi.fn(),
    findSettingsByUser: vi.fn(),
    decrypt: vi.fn((s: string) => s.replace(/^ENC:/, "")),
    ghAuth: {
      getInstallationToken: vi.fn(),
      getInstallationId: vi.fn(),
      getInstallationIdByOrg: vi.fn(),
      getUserToken: vi.fn(),
    },
    canUseGitHubRepo: vi.fn(),
    getLocalGhToken: vi.fn(),
  }));

vi.mock("../../../src/config/env", () => ({ env: envMock }));
vi.mock("@repo/db", () => ({
  repos: {
    project: { findById: findProjectById },
    settings: { findByUser: findSettingsByUser },
  },
}));
vi.mock("../../../src/lib/encryption", () => ({ decrypt }));
vi.mock("../../../src/modules/github/github.auth", () => ghAuth);
vi.mock("../../../src/modules/github/github-access", () => ({ canUseGitHubRepo }));
vi.mock("../../../src/modules/github/github.local-auth", () => ({ getLocalGhToken }));

import { tokenFor } from "../../../src/modules/github/github.token";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ctxOrg = { userId: "u1", organizationId: "o1" } as any;

beforeEach(() => {
  vi.clearAllMocks();
  envMock.CLOUD_MODE = false;
  envMock.GITHUB_AUTH_MODE = undefined;
  findProjectById.mockResolvedValue(null);
  findSettingsByUser.mockResolvedValue(null);
  getLocalGhToken.mockResolvedValue(null);
  ghAuth.getUserToken.mockResolvedValue(null);
  ghAuth.getInstallationToken.mockResolvedValue("apptok");
  ghAuth.getInstallationId.mockResolvedValue(42);
  ghAuth.getInstallationIdByOrg.mockResolvedValue(42);
  // Default: gate grants — so the App branch mints and we can inspect its args.
  canUseGitHubRepo.mockResolvedValue(true);
});

describe("tokenFor funnel — op/repo threaded into the gate (GHSA-hp2g-hw7g-f3vm)", () => {
  it("threads op:'write' into canUseGitHubRepo for a mutating mint", async () => {
    await tokenFor(ctxOrg, "local", { owner: "acme", repo: "production-api", op: "write" });
    expect(canUseGitHubRepo).toHaveBeenCalledWith(
      ctxOrg,
      expect.objectContaining({ owner: "acme", repo: "production-api" }),
      "write",
      expect.anything(),
    );
  });

  it("threads the repo so the gate authorizes THIS repo, not owner-wide", async () => {
    await tokenFor(ctxOrg, "local", { owner: "acme", repo: "production-api", op: "write" });
    const target = canUseGitHubRepo.mock.calls[0][1];
    expect(target.repo).toBe("production-api");
  });

  it("defaults to op:'read' when the caller omits it (read callers unchanged)", async () => {
    await tokenFor(ctxOrg, "local", { owner: "acme", repo: "production-api" });
    expect(canUseGitHubRepo).toHaveBeenCalledWith(
      ctxOrg,
      expect.objectContaining({ owner: "acme" }),
      "read",
      expect.anything(),
    );
  });

  it("does NOT mint the App token when the gate denies a write (read-grant member)", async () => {
    canUseGitHubRepo.mockResolvedValue(false);
    const result = await tokenFor(ctxOrg, "local", { owner: "acme", repo: "production-api", op: "write" });
    // No shippable fallback present → the whole chain comes up empty.
    expect(result).toBeNull();
    expect(ghAuth.getInstallationToken).not.toHaveBeenCalled();
  });

  it("still mints when the gate grants the write", async () => {
    const result = await tokenFor(ctxOrg, "local", { owner: "acme", repo: "production-api", op: "write" });
    expect(result).toEqual({ token: "apptok", source: "app-installation" });
  });

  it("narrows the minted token to the repo it just authorized", async () => {
    await tokenFor(ctxOrg, "local", { owner: "acme", repo: "production-api", op: "write" });
    expect(ghAuth.getInstallationToken).toHaveBeenCalledWith(
      ctxOrg,
      "acme",
      undefined,
      { repositories: ["production-api"] },
    );
  });

  it("leaves the mint owner-wide only when no repo was named", async () => {
    await tokenFor(ctxOrg, "local", { owner: "acme" });
    expect(ghAuth.getInstallationToken).toHaveBeenCalledWith(ctxOrg, "acme", undefined, {
      repositories: undefined,
    });
  });

  it("demands owner AUTHORITY for a repo-less write, but only reach for a read", async () => {
    await tokenFor(ctxOrg, "local", { owner: "acme", op: "write" });
    expect(canUseGitHubRepo.mock.calls[0][3]).toEqual({ ownerLevel: "authority" });

    canUseGitHubRepo.mockClear();
    await tokenFor(ctxOrg, "local", { owner: "acme", op: "read" });
    expect(canUseGitHubRepo.mock.calls[0][3]).toEqual({ ownerLevel: "reach" });
  });
});

/**
 * The gate above protects the App branch. It is not the only credential the chain
 * can answer with: `gh-cli` is the instance OPERATOR's account-wide token and
 * `project` is a pasted clone token — neither belongs to the caller. Reading with a
 * borrowed credential is the feature; MUTATING with one would route around the gate
 * entirely, which is how GHSA-hp2g-hw7g-f3vm would have survived its own fix on a
 * gh-CLI instance.
 */
describe("borrowed credentials must clear the same gate for a write", () => {
  beforeEach(() => {
    envMock.GITHUB_AUTH_MODE = "cli"; // operator declared instance-wide CLI auth
    getLocalGhToken.mockResolvedValue("ghtok");
    findProjectById.mockResolvedValue({ cloneTokenEncrypted: "ENC:projtok" });
    ghAuth.getInstallationToken.mockResolvedValue(null); // App unavailable
  });

  it("gh-cli still serves a READ when the caller is not repo-authorized", async () => {
    canUseGitHubRepo.mockResolvedValue(false);
    const r = await tokenFor(ctxOrg, "local", { owner: "acme", repo: "production-api" });
    expect(r).toEqual({ token: "ghtok", source: "gh-cli" });
  });

  it("gh-cli is REFUSED for a write the caller is not authorized for", async () => {
    canUseGitHubRepo.mockResolvedValue(false);
    const r = await tokenFor(ctxOrg, "local", {
      owner: "acme",
      repo: "production-api",
      op: "write",
    });
    expect(r).toBeNull();
  });

  it("gh-cli still serves an AUTHORIZED write", async () => {
    canUseGitHubRepo.mockResolvedValue(true);
    const r = await tokenFor(ctxOrg, "local", {
      owner: "acme",
      repo: "production-api",
      op: "write",
    });
    expect(r).toEqual({ token: "ghtok", source: "gh-cli" });
  });

  it("a write that names NO owner cannot borrow either — nothing authorized it", async () => {
    // `POST /user/repos` (createRepository with no owner) reaches here with no owner,
    // so no gate can have passed. Borrowing the operator's gh token would create the
    // repo in the OPERATOR's personal account on a member's say-so.
    canUseGitHubRepo.mockResolvedValue(true); // irrelevant: never consulted without an owner
    const r = await tokenFor(ctxOrg, "local", { op: "write" });
    expect(r).toBeNull();
    expect(canUseGitHubRepo).not.toHaveBeenCalled();
  });

  it("the project clone token is refused for an unauthorized write too", async () => {
    getLocalGhToken.mockResolvedValue(null);
    canUseGitHubRepo.mockResolvedValue(false);
    const r = await tokenFor(ctxOrg, "local", {
      owner: "acme",
      repo: "production-api",
      projectId: "p1",
      op: "write",
    });
    expect(r).toBeNull();
  });

  it("…and still serves the same project token for a read", async () => {
    getLocalGhToken.mockResolvedValue(null);
    canUseGitHubRepo.mockResolvedValue(false);
    const r = await tokenFor(ctxOrg, "local", {
      owner: "acme",
      repo: "production-api",
      projectId: "p1",
    });
    expect(r).toEqual({ token: "projtok", source: "project" });
  });
});
