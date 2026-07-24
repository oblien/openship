import { beforeEach, describe, expect, it, vi } from "vitest";

// Isolate the resolver: every credential source it consults is mocked, so the
// test asserts ONLY the precedence/fall-through wiring in resolveBuildGitToken.
const { tokenFor, requireTokenFor, isPublicRepo, resolveServerGitCredential, getLocalGhToken } =
  vi.hoisted(() => ({
    tokenFor: vi.fn(),
    requireTokenFor: vi.fn(),
    isPublicRepo: vi.fn(),
    resolveServerGitCredential: vi.fn(),
    getLocalGhToken: vi.fn(),
  }));

vi.mock("../../../src/modules/github/github.token", () => ({ tokenFor, requireTokenFor }));
vi.mock("../../../src/modules/github/github.http", () => ({ isPublicRepo }));
vi.mock("../../../src/modules/github/server-github.service", () => ({ resolveServerGitCredential }));
vi.mock("../../../src/modules/github/github.local-auth", () => ({ getLocalGhToken }));

import { resolveBuildGitToken } from "../../../src/modules/github/clone-auth";

const ctx = { userId: "u1", organizationId: "o1" } as any;
const base = { ctx, projectId: "p1", owner: "acme", repo: "app" };

beforeEach(() => {
  vi.clearAllMocks();
  getLocalGhToken.mockResolvedValue(null);
  tokenFor.mockResolvedValue(null);
  isPublicRepo.mockResolvedValue(false);
  resolveServerGitCredential.mockResolvedValue(null);
  requireTokenFor.mockRejectedValue(new Error("GITHUB_REMOTE_TOKEN_REQUIRED"));
});

describe("resolveBuildGitToken — local build", () => {
  it("uses the local gh token directly, never touching the remote/server chain", async () => {
    getLocalGhToken.mockResolvedValue("ghtok");
    const res = await resolveBuildGitToken({ ...base, buildStrategy: "local" });
    expect(res).toEqual({ token: "ghtok" });
    expect(resolveServerGitCredential).not.toHaveBeenCalled();
    expect(tokenFor).not.toHaveBeenCalled();
  });

  it("falls through to the resolver chain when no local gh", async () => {
    getLocalGhToken.mockResolvedValue(null);
    tokenFor.mockResolvedValue({ token: "pat" });
    const res = await resolveBuildGitToken({ ...base, buildStrategy: "local" });
    expect(res).toEqual({ token: "pat" });
    expect(tokenFor).toHaveBeenCalledWith(ctx, "local", expect.anything());
  });
});

describe("resolveBuildGitToken — server build, per-server credential PRECEDENCE", () => {
  it("a per-server token wins over App/PAT (server chain not consulted)", async () => {
    resolveServerGitCredential.mockResolvedValue({ token: "srvtok" });
    const res = await resolveBuildGitToken({ ...base, buildStrategy: "server", serverId: "s1" });
    expect(res).toEqual({ token: "srvtok" });
    expect(resolveServerGitCredential).toHaveBeenCalledWith(
      expect.objectContaining({ serverId: "s1", owner: "acme", repo: "app" }),
    );
    expect(tokenFor).not.toHaveBeenCalled();
  });

  it("a per-server SSH credential wins and is passed through verbatim", async () => {
    const ssh = { keyKind: "server-key" as const, privateKey: "KEY", knownHosts: "KH" };
    resolveServerGitCredential.mockResolvedValue({ ssh });
    const res = await resolveBuildGitToken({ ...base, buildStrategy: "server", serverId: "s1" });
    expect(res).toEqual({ ssh });
    expect(tokenFor).not.toHaveBeenCalled();
  });
});

describe("resolveBuildGitToken — server build, fall-through when server has no credential", () => {
  it("falls to the App/PAT remote chain when the server has none", async () => {
    resolveServerGitCredential.mockResolvedValue(null);
    tokenFor.mockResolvedValue({ token: "apptok" });
    const res = await resolveBuildGitToken({ ...base, buildStrategy: "server", serverId: "s1" });
    expect(res).toEqual({ token: "apptok" });
    expect(resolveServerGitCredential).toHaveBeenCalledTimes(1);
    expect(tokenFor).toHaveBeenCalledWith(ctx, "remote", expect.anything());
  });

  it("never consults the per-server credential when no serverId is given", async () => {
    tokenFor.mockResolvedValue({ token: "apptok" });
    const res = await resolveBuildGitToken({ ...base, buildStrategy: "server" });
    expect(res).toEqual({ token: "apptok" });
    expect(resolveServerGitCredential).not.toHaveBeenCalled();
  });

  it("clones a public repo anonymously when no credential resolves", async () => {
    isPublicRepo.mockResolvedValue(true);
    const res = await resolveBuildGitToken({ ...base, buildStrategy: "server", serverId: "s1" });
    expect(res).toEqual({});
  });

  it("signals relay fallback when opted in, the repo is private, and a gh identity exists to forward", async () => {
    // The relay vends the operator's LOCAL gh token on demand, so resolveBuildGitToken
    // only signals { relay: true } when a local gh identity actually exists — otherwise
    // the relay would open with nothing to forward (see clone-auth relay gate).
    getLocalGhToken.mockResolvedValue("ghtok");
    const res = await resolveBuildGitToken({
      ...base,
      buildStrategy: "server",
      serverId: "s1",
      allowRelayFallback: true,
    });
    expect(res).toEqual({ relay: true });
  });

  it("degrades to an api-host clone (flagged) for docker clone-on-server", async () => {
    getLocalGhToken.mockResolvedValue("localtok");
    const res = await resolveBuildGitToken({
      ...base,
      buildStrategy: "server",
      serverId: "s1",
      allowApiHostFallback: true,
    });
    expect(res).toEqual({ token: "localtok", apiHostFallback: true });
  });

  it("throws the actionable error when nothing is resolvable", async () => {
    await expect(
      resolveBuildGitToken({ ...base, buildStrategy: "server", serverId: "s1" }),
    ).rejects.toThrow("GITHUB_REMOTE_TOKEN_REQUIRED");
    expect(requireTokenFor).toHaveBeenCalledWith(ctx, "remote", expect.anything());
  });
});
