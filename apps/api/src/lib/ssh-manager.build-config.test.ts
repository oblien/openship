import { describe, expect, it, vi, beforeEach } from "vitest";

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
vi.mock("./box-org", () => ({ isLocalHostRow: vi.fn() }));

// The path allowlist is tested on its own (ssh-key-path); here we only need to
// know WHETHER the path branch runs, so make it an identity + assert on the read.
vi.mock("./ssh-key-path", () => ({
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

import { buildSshConfig } from "./ssh-manager";
// REAL encryption — the whole point is that a stored enc1: value round-trips.
import { encryptSecretField } from "./credential-encryption";

const base = { sshHost: "10.0.0.1", sshAuthMethod: "key" as const };

beforeEach(() => {
  readFileSync.mockClear();
});

describe("buildSshConfig — pasted/uploaded key material", () => {
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
