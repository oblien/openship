import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Priority tests for the SINGLE token-issuance entry point: `tokenFor`
 * (github.token.ts). Every credential SOURCE it reads is mocked, so these
 * assert ONLY the priority/refusal wiring per (mode × purpose):
 *
 *   - CLOUD_MODE            : project → user-pat → app → oauth → null   (no gh)
 *   - self-hosted "local"   : gh-cli → app → project → user-pat → oauth → null
 *   - self-hosted "remote"  : project → user-pat → app → null   (gh REFUSED, no oauth)
 *
 * Plus a drift-guard: `canResolveTokenFor` (the preflight existence-mirror)
 * must report the SAME source `tokenFor` would mint.
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
// NOT mocked: @repo/core — requireTokenFor needs the real AppError.

import { tokenFor, canResolveTokenFor, requireTokenFor } from "../../../src/modules/github/github.token";

const ctxNoOrg = { userId: "u1" } as any; // zero-auth / single-user operator
const ctxOrg = { userId: "u1", organizationId: "o1" } as any;
const withOwner = { projectId: "p1", owner: "acme", repo: "app" };

// ── Source setters (each returns the credential when "present", else nothing) ──
function setProjectPat(tok: string | null) {
  findProjectById.mockResolvedValue(tok ? { cloneTokenEncrypted: `ENC:${tok}` } : null);
}
function setSettings(opts: { userPat?: string | null; asDefault?: boolean; ghOptIn?: boolean }) {
  findSettingsByUser.mockResolvedValue({
    cloneTokenEncrypted: opts.userPat ? `ENC:${opts.userPat}` : null,
    cloneTokenAsDefault: opts.asDefault ?? true,
    ghCliOperatorOptedIn: opts.ghOptIn ?? false,
  });
}
function setApp(present: boolean) {
  canUseGitHubRepo.mockResolvedValue(present);
  ghAuth.getInstallationToken.mockResolvedValue(present ? "apptok" : null);
  ghAuth.getInstallationId.mockResolvedValue(present ? 42 : null);
  ghAuth.getInstallationIdByOrg.mockResolvedValue(present ? 42 : null);
}
function setOauth(tok: string | null) {
  ghAuth.getUserToken.mockResolvedValue(tok);
}
function setGh(tok: string | null) {
  getLocalGhToken.mockResolvedValue(tok);
}

beforeEach(() => {
  vi.clearAllMocks();
  envMock.CLOUD_MODE = false;
  envMock.GITHUB_AUTH_MODE = undefined;
  // Baseline: nothing resolves.
  setProjectPat(null);
  findSettingsByUser.mockResolvedValue(null);
  setApp(false);
  setOauth(null);
  setGh(null);
  decrypt.mockImplementation((s: string) => s.replace(/^ENC:/, ""));
});

describe("tokenFor — CLOUD_MODE (project → user-pat → app → oauth)", () => {
  beforeEach(() => {
    envMock.CLOUD_MODE = true;
  });

  it("project PAT wins over everything", async () => {
    setProjectPat("projtok");
    setSettings({ userPat: "usertok" });
    setApp(true);
    setOauth("oauthtok");
    expect(await tokenFor(ctxOrg, "remote", withOwner)).toEqual({ token: "projtok", source: "project" });
    expect(getLocalGhToken).not.toHaveBeenCalled(); // gh never loads on SaaS
  });

  it("falls to user-pat when no project token", async () => {
    setSettings({ userPat: "usertok" });
    setApp(true);
    expect(await tokenFor(ctxOrg, "remote", withOwner)).toEqual({ token: "usertok", source: "user-pat" });
  });

  it("falls to the App installation when no PAT", async () => {
    setApp(true);
    expect(await tokenFor(ctxOrg, "remote", withOwner)).toEqual({ token: "apptok", source: "app-installation" });
  });

  it("falls to OAuth when no PAT and no App", async () => {
    setOauth("oauthtok");
    expect(await tokenFor(ctxOrg, "remote", withOwner)).toEqual({ token: "oauthtok", source: "user-oauth" });
  });

  it("returns null when nothing resolves", async () => {
    expect(await tokenFor(ctxOrg, "remote", withOwner)).toBeNull();
  });
});

describe("tokenFor — self-hosted local (gh-cli → app → project → user-pat → oauth)", () => {
  it("gh CLI wins over App and PATs (operator, no org)", async () => {
    setGh("ghtok");
    setApp(true);
    setProjectPat("projtok");
    setSettings({ userPat: "usertok" });
    expect(await tokenFor(ctxNoOrg, "local", withOwner)).toEqual({ token: "ghtok", source: "gh-cli" });
  });

  it("App wins once gh is absent", async () => {
    setApp(true);
    setProjectPat("projtok");
    expect(await tokenFor(ctxNoOrg, "local", withOwner)).toEqual({ token: "apptok", source: "app-installation" });
  });

  it("project PAT wins once gh + App are absent", async () => {
    setProjectPat("projtok");
    setSettings({ userPat: "usertok" });
    expect(await tokenFor(ctxNoOrg, "local", withOwner)).toEqual({ token: "projtok", source: "project" });
  });

  it("user PAT then OAuth as the tail", async () => {
    setSettings({ userPat: "usertok" });
    expect(await tokenFor(ctxNoOrg, "local", withOwner)).toEqual({ token: "usertok", source: "user-pat" });
    setSettings({ userPat: null });
    setOauth("oauthtok");
    expect(await tokenFor(ctxNoOrg, "local", withOwner)).toEqual({ token: "oauthtok", source: "user-oauth" });
  });

  it("a user PAT NOT marked default is ignored", async () => {
    setSettings({ userPat: "usertok", asDefault: false });
    expect(await tokenFor(ctxNoOrg, "local", withOwner)).toBeNull();
  });
});

describe("tokenFor — gh-CLI authorization gate (HIGH #7)", () => {
  it("refuses gh for a REMOTE build even on self-hosted with gh present", async () => {
    setGh("ghtok");
    // remote self-hosted: gh must NEVER be returned; nothing else present → null.
    expect(await tokenFor(ctxNoOrg, "remote", withOwner)).toBeNull();
  });

  it("refuses gh for a multi-user org member who hasn't opted in (local)", async () => {
    setGh("ghtok");
    setSettings({ ghOptIn: false });
    setProjectPat("projtok");
    // org context + not opted in → gh skipped → falls to project PAT.
    expect(await tokenFor(ctxOrg, "local", withOwner)).toEqual({ token: "projtok", source: "project" });
  });

  it("allows gh for an org operator who opted in (local)", async () => {
    setGh("ghtok");
    setSettings({ ghOptIn: true });
    expect(await tokenFor(ctxOrg, "local", withOwner)).toEqual({ token: "ghtok", source: "gh-cli" });
  });

  it("allows gh in instance-wide cli auth mode (local)", async () => {
    envMock.GITHUB_AUTH_MODE = "cli";
    setGh("ghtok");
    expect(await tokenFor(ctxOrg, "local", withOwner)).toEqual({ token: "ghtok", source: "gh-cli" });
  });
});

describe("tokenFor — self-hosted remote (project → user-pat → app, gh refused, no oauth)", () => {
  it("project PAT wins", async () => {
    setProjectPat("projtok");
    setSettings({ userPat: "usertok" });
    setApp(true);
    expect(await tokenFor(ctxOrg, "remote", withOwner)).toEqual({ token: "projtok", source: "project" });
  });

  it("user PAT then App", async () => {
    setSettings({ userPat: "usertok" });
    setApp(true);
    expect(await tokenFor(ctxOrg, "remote", withOwner)).toEqual({ token: "usertok", source: "user-pat" });
    setSettings({ userPat: null });
    expect(await tokenFor(ctxOrg, "remote", withOwner)).toEqual({ token: "apptok", source: "app-installation" });
  });

  it("does NOT fall through to OAuth on self-hosted remote", async () => {
    setOauth("oauthtok");
    expect(await tokenFor(ctxOrg, "remote", withOwner)).toBeNull();
  });
});

describe("requireTokenFor — actionable throw", () => {
  it("throws GITHUB_REMOTE_TOKEN_REQUIRED for remote with no credential", async () => {
    await expect(requireTokenFor(ctxOrg, "remote", withOwner)).rejects.toMatchObject({
      code: "GITHUB_REMOTE_TOKEN_REQUIRED",
      statusCode: 403,
    });
  });
});

describe("canResolveTokenFor — drift guard (same source tokenFor mints)", () => {
  const rows: Array<{ name: string; cloud?: boolean; ctx: any; purpose: "local" | "remote"; setup: () => void; expected: string | null }> = [
    { name: "cloud project", cloud: true, ctx: ctxOrg, purpose: "remote", setup: () => setProjectPat("t"), expected: "project" },
    { name: "cloud app", cloud: true, ctx: ctxOrg, purpose: "remote", setup: () => setApp(true), expected: "app-installation" },
    { name: "cloud oauth", cloud: true, ctx: ctxOrg, purpose: "remote", setup: () => setOauth("t"), expected: "user-oauth" },
    { name: "local gh", ctx: ctxNoOrg, purpose: "local", setup: () => { setGh("t"); setApp(true); }, expected: "gh-cli" },
    { name: "local app", ctx: ctxNoOrg, purpose: "local", setup: () => setApp(true), expected: "app-installation" },
    { name: "remote project", ctx: ctxOrg, purpose: "remote", setup: () => setProjectPat("t"), expected: "project" },
    { name: "remote none", ctx: ctxOrg, purpose: "remote", setup: () => {}, expected: null },
  ];

  for (const row of rows) {
    it(`${row.name}: canResolveTokenFor === tokenFor.source`, async () => {
      envMock.CLOUD_MODE = !!row.cloud;
      row.setup();
      const minted = await tokenFor(row.ctx, row.purpose, withOwner);
      const previewed = await canResolveTokenFor(row.ctx, row.purpose, withOwner);
      expect(previewed).toBe(row.expected);
      expect(minted?.source ?? null).toBe(row.expected);
    });
  }
});
