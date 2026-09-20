import { beforeEach, describe, expect, it, vi } from "vitest";
import { GITHUB_KNOWN_HOSTS } from "@repo/platform/engine/modules/github/github-known-hosts";

// Mutable env so a single suite can exercise both self-hosted and CLOUD_MODE.
const { envMock, getByServer, listByServer } = vi.hoisted(() => ({
  envMock: { CLOUD_MODE: false } as { CLOUD_MODE: boolean },
  getByServer: vi.fn(),
  listByServer: vi.fn(),
}));

vi.mock("@repo/platform/engine/config/env", () => ({ env: envMock }));
vi.mock("@repo/db", () => ({
  repos: {
    serverGithubAuth: { getByServer, deleteByServer: vi.fn() },
    githubDeployKey: { listByServer, deleteByServer: vi.fn() },
  },
}));
vi.mock("@repo/platform/engine/lib/encryption", () => ({
  encrypt: (s: string) => `ENC:${s}`,
  decrypt: (s: string) => s.replace(/^ENC:/, ""),
}));
// Sibling modules imported at load time — stubbed so the service loads in isolation.
vi.mock("@repo/platform/engine/modules/github/github.local-auth", () => ({
  startServerDeviceFlow: vi.fn(),
  getDeviceFlowStatus: vi.fn(),
  cancelDeviceFlow: vi.fn(),
}));
vi.mock("@repo/platform/engine/modules/github/github.http", () => ({ ghFetchSoft: vi.fn() }));
vi.mock("@repo/platform/engine/modules/github/github.service", () => ({
  createDeployKey: vi.fn(),
  revokeDeployKey: vi.fn(),
}));

import {
  resolveServerGitCredential,
  canResolveServerGitCredential,
  disconnectServerGithub,
} from "@repo/platform/engine/modules/github/server-github.service";

const ctx = { userId: "u1", organizationId: "o1" } as any;
const resolve = (owner: string | null = "acme", repo: string | null = "app") =>
  resolveServerGitCredential({ serverId: "s1", ctx, owner, repo });

beforeEach(() => {
  vi.clearAllMocks();
  envMock.CLOUD_MODE = false;
  listByServer.mockResolvedValue([]);
});

describe("resolveServerGitCredential — CLOUD_MODE guard", () => {
  it("returns null and never reads the DB in cloud", async () => {
    envMock.CLOUD_MODE = true;
    expect(await resolve()).toBeNull();
    expect(getByServer).not.toHaveBeenCalled();
  });
});

describe("resolveServerGitCredential — mode mapping", () => {
  it("no config row → null (fall through to the shared chain)", async () => {
    getByServer.mockResolvedValue(null);
    expect(await resolve()).toBeNull();
  });

  it("token mode → decrypted token", async () => {
    getByServer.mockResolvedValue({ mode: "token", tokenEncrypted: "ENC:ghp_abc" });
    expect(await resolve()).toEqual({ token: "ghp_abc" });
  });

  it("token mode without stored token → null", async () => {
    getByServer.mockResolvedValue({ mode: "token", tokenEncrypted: null });
    expect(await resolve()).toBeNull();
  });

  it("ssh-server-key mode → decrypted key with the PINNED known_hosts", async () => {
    getByServer.mockResolvedValue({
      mode: "ssh-server-key",
      serverKeyPrivateEncrypted: "ENC:PRIVATE",
    });
    expect(await resolve()).toEqual({
      ssh: { keyKind: "server-key", privateKey: "PRIVATE", knownHosts: GITHUB_KNOWN_HOSTS },
    });
  });

  it("ssh-deploy-key mode without owner/repo → null (can't scope a deploy key)", async () => {
    getByServer.mockResolvedValue({ mode: "ssh-deploy-key", organizationId: "o1" });
    expect(await resolve(null, null)).toBeNull();
  });
});

describe("canResolveServerGitCredential — matches the resolver verdict", () => {
  it("false in cloud", async () => {
    envMock.CLOUD_MODE = true;
    expect(await canResolveServerGitCredential("s1")).toBe(false);
  });
  it("false when no row", async () => {
    getByServer.mockResolvedValue(null);
    expect(await canResolveServerGitCredential("s1")).toBe(false);
  });
  it("token mode true only with stored material", async () => {
    getByServer.mockResolvedValue({ mode: "token", tokenEncrypted: "ENC:x" });
    expect(await canResolveServerGitCredential("s1")).toBe(true);
    getByServer.mockResolvedValue({ mode: "token", tokenEncrypted: null });
    expect(await canResolveServerGitCredential("s1")).toBe(false);
  });
  it("ssh-deploy-key is true without material (minted lazily at deploy)", async () => {
    getByServer.mockResolvedValue({ mode: "ssh-deploy-key" });
    expect(await canResolveServerGitCredential("s1")).toBe(true);
  });
});

describe("mutator cloud guard", () => {
  it("disconnect throws in CLOUD_MODE before touching any DB", async () => {
    envMock.CLOUD_MODE = true;
    await expect(disconnectServerGithub(ctx, "s1")).rejects.toThrow(/self-hosted/i);
    expect(listByServer).not.toHaveBeenCalled();
  });
});
