import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

/**
 * buildSshConfig is the single choke point every SSH connection funnels
 * through. These tests pin the paste/upload key path added for a remote
 * instance whose key lives in the browser, not on the API host:
 *
 *   - stored `enc1:` material decrypts to config.privateKey (never a file read),
 *   - pasted content wins over a host path,
 *   - the ephemeral test-connection path (RAW, unencrypted material) passes
 *     through verbatim, and
 *   - the host-path fallback still reads the file when no content is present.
 */

// Keep ssh-manager's heavy transitive graph out of the way: this suite only
// exercises buildSshConfig, which touches none of these at call time.
vi.mock("@repo/db", () => ({ repos: { server: { get: vi.fn() } } }));
vi.mock("@repo/adapters", async () => ({
  ...(await import("../../../../packages/adapters/src/system/errors")),
  HOST_STATE_DIR: "/root/.openship",
  createHostExecutor: vi.fn(),
  hostChannelHealth: vi.fn(),
  probeTcp: vi.fn(),
}));
vi.mock("@repo/platform/engine/lib/box-org", () => ({ isLocalHostRow: vi.fn() }));

// The path allowlist is tested on its own (ssh-key-path); here we only need to
// know WHETHER the path branch runs, so make it an identity + assert on the read.
vi.mock("@repo/platform/engine/lib/ssh-key-path", () => ({
  resolveSafeSshKeyPath: vi.fn((p: string) => p),
  operatorSshKeyRoots: vi.fn(() => []),
}));

// Control the file read without touching the real filesystem; leave the rest of
// node:fs real so nothing else that imports it breaks.
const readFileSync = vi.fn((..._args: unknown[]) => "FILE-ON-HOST-KEY");
vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  readFileSync: (...args: unknown[]) => readFileSync(...args),
}));

import { buildSshConfig } from "@repo/platform/engine/lib/ssh-manager";
// REAL encryption — the whole point is that a stored enc1: value round-trips.
import { encryptSecretField } from "@repo/platform/engine/lib/credential-encryption";

const base = { sshHost: "10.0.0.1", sshAuthMethod: "key" as const };

beforeEach(() => {
  readFileSync.mockClear();
});
afterEach(() => vi.unstubAllEnvs());

describe("native SSH host policy", () => {
  it("refuses ambient agent/config and host key files before reading any credentials", async () => {
    vi.stubEnv("OPENSHIP_NATIVE", "true");
    vi.stubEnv("OPENSHIP_NATIVE_ALLOW_HOST_EXECUTION", "false");
    for (const settings of [
      { ...base, sshKeyPath: "/root/.ssh/id_ed25519" },
      { ...base, sshAuthMethod: "agent" },
    ]) await expect(buildSshConfig(settings)).rejects.toMatchObject({ code: "HOST_EXECUTION_DISABLED" });
    expect(readFileSync).not.toHaveBeenCalled();
  });
  it("allows explicit remote passwords and pasted keys without host access", async () => {
    vi.stubEnv("OPENSHIP_NATIVE", "true");
    vi.stubEnv("OPENSHIP_NATIVE_ALLOW_HOST_EXECUTION", "false");
    expect(await buildSshConfig({ ...base, sshPrivateKey: "EXPLICIT-KEY", sshKeyPath: "/root/.ssh/id_ed25519" }))
      .toMatchObject({ privateKey: "EXPLICIT-KEY" });
    expect(await buildSshConfig({ ...base, sshAuthMethod: "password", sshPassword: "EXPLICIT-PASSWORD" }))
      .toMatchObject({ password: "EXPLICIT-PASSWORD" });
    expect(readFileSync).not.toHaveBeenCalled();
  });
  it("retains host-key access when the owning application explicitly enables it", async () => {
    vi.stubEnv("OPENSHIP_NATIVE", "true");
    vi.stubEnv("OPENSHIP_NATIVE_ALLOW_HOST_EXECUTION", "true");
    expect(await buildSshConfig({ ...base, sshKeyPath: "/root/.ssh/id_ed25519" })).toMatchObject({ privateKey: "FILE-ON-HOST-KEY" });
    expect(readFileSync).toHaveBeenCalledOnce();
  });
});

describe("buildSshConfig — pasted/uploaded key material", () => {
  it("carries Cloudflare through password, encrypted-key and agent authentication", async () => {
    const settings = { sshHost: "ssh.example.test", sshTransport: "cloudflare" };
    expect(await buildSshConfig({ ...settings, sshAuthMethod: "password", sshPassword: encryptSecretField("password") }))
      .toMatchObject({ sshTransport: "cloudflare", password: "password" });
    expect(await buildSshConfig({ ...settings, sshAuthMethod: "key", sshPrivateKey: encryptSecretField("key"), sshKeyPassphrase: encryptSecretField("passphrase") }))
      .toMatchObject({ sshTransport: "cloudflare", privateKey: "key", privateKeyPassphrase: "passphrase" });
    vi.stubEnv("SSH_AUTH_SOCK", "/tmp/test-agent.sock");
    expect(await buildSshConfig({ ...settings, sshAuthMethod: "agent" }))
      .toMatchObject({ sshTransport: "cloudflare", useSystemSsh: true, sshAgent: "/tmp/test-agent.sock" });
  });

  it("decrypts stored material into privateKey and never reads a file", async () => {
    const config = await buildSshConfig({
      ...base,
      sshPrivateKey: encryptSecretField("STORED-PRIVATE-KEY"),
    });
    expect(config?.privateKey).toBe("STORED-PRIVATE-KEY");
    expect(readFileSync).not.toHaveBeenCalled();
  });

  it("prefers pasted content over a host path", async () => {
    const config = await buildSshConfig({
      ...base,
      sshPrivateKey: encryptSecretField("STORED-PRIVATE-KEY"),
      sshKeyPath: "/root/.ssh/id_ed25519",
    });
    expect(config?.privateKey).toBe("STORED-PRIVATE-KEY");
    expect(readFileSync).not.toHaveBeenCalled();
  });

  it("passes a raw (unencrypted) ephemeral key through verbatim", async () => {
    // The test-connection path sends the key the operator just pasted, before
    // anything is persisted — decryptSecretField returns a non-enc1: value as-is.
    const raw = "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----";
    const config = await buildSshConfig({ ...base, sshPrivateKey: raw });
    expect(config?.privateKey).toBe(raw);
    expect(readFileSync).not.toHaveBeenCalled();
  });

  it("applies the passphrase alongside pasted content", async () => {
    const config = await buildSshConfig({
      ...base,
      sshPrivateKey: encryptSecretField("STORED-PRIVATE-KEY"),
      sshKeyPassphrase: encryptSecretField("s3cret-pass"),
    });
    expect(config?.privateKey).toBe("STORED-PRIVATE-KEY");
    expect(config?.privateKeyPassphrase).toBe("s3cret-pass");
  });

  it("still reads the host file when only a path is set", async () => {
    const config = await buildSshConfig({ ...base, sshKeyPath: "/root/.ssh/id_ed25519" });
    expect(config?.privateKey).toBe("FILE-ON-HOST-KEY");
    expect(readFileSync).toHaveBeenCalledTimes(1);
  });

  it("returns null for key auth with neither content nor path", async () => {
    expect(await buildSshConfig({ ...base })).toBeNull();
  });
});
