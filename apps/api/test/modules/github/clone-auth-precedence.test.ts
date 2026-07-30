import { beforeEach, describe, expect, it, vi } from "vitest";

// Isolate the resolver: every credential source it consults is mocked, so the
// test asserts ONLY the precedence/fall-through wiring in resolveBuildGitToken.
const {
  tokenFor,
  requireTokenFor,
  isPublicRepo,
  resolveServerGitCredential,
  getLocalGhToken,
  probeServerGitAccess,
} = vi.hoisted(() => ({
  tokenFor: vi.fn(),
  requireTokenFor: vi.fn(),
  isPublicRepo: vi.fn(),
  resolveServerGitCredential: vi.fn(),
  getLocalGhToken: vi.fn(),
  probeServerGitAccess: vi.fn(),
}));

vi.mock("../../../src/modules/github/github.token", () => ({ tokenFor, requireTokenFor }));
vi.mock("../../../src/modules/github/github.http", () => ({ isPublicRepo }));
vi.mock("../../../src/modules/github/server-github.service", () => ({ resolveServerGitCredential }));
vi.mock("../../../src/modules/github/github.local-auth", () => ({
  getLocalGhToken,
  // The real one is just this predicate over getLocalGhToken (it's the single
  // definition of the relay's precondition), so derive it from the same mock.
  hasLocalGitIdentity: async () => !!(await getLocalGhToken()),
}));
vi.mock("../../../src/modules/github/server-git-ambient", () => ({ probeServerGitAccess }));

import { resolveBuildGitToken } from "../../../src/modules/github/clone-auth";

const ctx = { userId: "u1", organizationId: "o1" } as any;
const base = { ctx, projectId: "p1", owner: "acme", repo: "app" };

beforeEach(() => {
  vi.clearAllMocks();
  getLocalGhToken.mockResolvedValue(null);
  tokenFor.mockResolvedValue(null);
  isPublicRepo.mockResolvedValue(false);
  resolveServerGitCredential.mockResolvedValue(null);
  probeServerGitAccess.mockResolvedValue(null);
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
    // Flagged, not `{}` — the pipeline must tell "nothing needed" (clone on the
    // server) from "nothing available" (fall back to an api-host clone).
    expect(res).toEqual({ anonymous: true });
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

  it("passes a per-server DEPLOY-KEY ssh credential through verbatim", async () => {
    const ssh = { keyKind: "deploy-key" as const, privateKey: "DK", knownHosts: "KH" };
    resolveServerGitCredential.mockResolvedValue({ ssh });
    const res = await resolveBuildGitToken({ ...base, buildStrategy: "server", serverId: "s1" });
    expect(res).toEqual({ ssh });
    expect(tokenFor).not.toHaveBeenCalled();
  });

  it("still clones a PUBLIC repo on the server when isPublicRepo could not confirm it", async () => {
    // The regression: isPublicRepo is unauthenticated and fails CLOSED (60/hr/IP),
    // so a rate-limited or flaky call reported a public repo as private and the
    // deploy fell back to an api-host clone + transfer. The server-side attempt is
    // the authority, and it must override that "no".
    isPublicRepo.mockResolvedValue(false);
    probeServerGitAccess.mockResolvedValue({ via: "anonymous" });
    const res = await resolveBuildGitToken({
      ...base,
      buildStrategy: "server",
      serverId: "s1",
      serverExecutor: { exec: vi.fn() } as any,
      repoUrl: "https://github.com/acme/app.git",
      allowApiHostFallback: true,
    });
    // Anonymous, NOT ambient: the clone carries no credential of any kind.
    expect(res).toEqual({ anonymous: true });
  });

  it("uses the server's OWN verified git access before the App/PAT chain and the api-host fallback", async () => {
    // Nothing of ours reaches the server, but the server itself can read the repo.
    // NOTE: forwarding is step 1 by design, so this asserts ambient beats
    // everything BELOW it — with no forwardable identity, ambient wins.
    getLocalGhToken.mockResolvedValue(null); // nothing to forward
    probeServerGitAccess.mockResolvedValue({ via: "gh" });
    const res = await resolveBuildGitToken({
      ...base,
      buildStrategy: "server",
      serverId: "s1",
      serverExecutor: { exec: vi.fn() } as any,
      repoUrl: "https://github.com/acme/app.git",
      allowRelayFallback: true,
      allowApiHostFallback: true,
    });
    // Preferred over both: no credential moves in either direction.
    expect(res).toEqual({ ambient: { via: "gh" } });
  });

  it("prefers the server's own access over an App/PAT token (operator precedence)", async () => {
    // The self-hosted model has no GitHub App, so the operator's own switches come
    // first: a server that can already read the repo needs nothing shipped to it.
    tokenFor.mockResolvedValue({ token: "apptok" });
    probeServerGitAccess.mockResolvedValue({ via: "gh" });
    const res = await resolveBuildGitToken({
      ...base,
      buildStrategy: "server",
      serverId: "s1",
      serverExecutor: { exec: vi.fn() } as any,
      repoUrl: "https://github.com/acme/app.git",
    });
    expect(res).toEqual({ ambient: { via: "gh" } });
  });

  it("still resolves an App/PAT token when the server has no access of its own", async () => {
    tokenFor.mockResolvedValue({ token: "apptok" });
    probeServerGitAccess.mockResolvedValue(null);
    const res = await resolveBuildGitToken({
      ...base,
      buildStrategy: "server",
      serverId: "s1",
      serverExecutor: { exec: vi.fn() } as any,
      repoUrl: "https://github.com/acme/app.git",
    });
    expect(res).toEqual({ token: "apptok" });
  });

  it("does not probe when the clone won't run on the server (no executor passed)", async () => {
    await expect(
      resolveBuildGitToken({
        ...base,
        buildStrategy: "server",
        serverId: "s1",
        repoUrl: "https://github.com/acme/app.git",
      }),
    ).rejects.toThrow("GITHUB_REMOTE_TOKEN_REQUIRED");
    expect(probeServerGitAccess).not.toHaveBeenCalled();
  });

  it("forwards FIRST when the operator opted in and a local identity exists", async () => {
    // Step 1 of the chain: an explicit operator switch outranks the server's own
    // credentials, so the probe is never even reached.
    getLocalGhToken.mockResolvedValue("ghtok");
    probeServerGitAccess.mockResolvedValue({ via: "gh" });
    const res = await resolveBuildGitToken({
      ...base,
      buildStrategy: "server",
      serverId: "s1",
      serverExecutor: { exec: vi.fn() } as any,
      repoUrl: "https://github.com/acme/app.git",
      allowRelayFallback: true,
    });
    expect(res).toEqual({ relay: true });
    expect(probeServerGitAccess).not.toHaveBeenCalled();
  });

  it("api-host fallback carries a tokenFor('local') token when no local gh exists", async () => {
    // No shippable remote token, no local gh identity — resolveLocalCredential
    // still resolves a LOCAL token via tokenFor('local'), flagged apiHostFallback
    // so the caller never ships it off-host.
    getLocalGhToken.mockResolvedValue(null);
    tokenFor.mockImplementation((_c: unknown, purpose: string) =>
      Promise.resolve(purpose === "local" ? { token: "localpat" } : null),
    );
    const res = await resolveBuildGitToken({
      ...base,
      buildStrategy: "server",
      serverId: "s1",
      allowApiHostFallback: true,
    });
    expect(res).toEqual({ token: "localpat", apiHostFallback: true });
  });
});
