import { beforeEach, describe, expect, it, vi } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { MigrationSourceInputSchema } from "@repo/contracts";
const h = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup: h.lookup }));
import { buildSshConfig } from "@repo/platform/engine/lib/ssh-manager";
import { isLocalHostRow } from "@repo/platform/engine/lib/box-org";

const input = { sshHost: "source.example.com", sshAuthMethod: "password", sshPassword: "fixture-password" } as const;
const key = Buffer.from("fixture-host-public-key");
const settings = { ...input, purpose: "migration_source", sshHostKey: key.toString("base64") };
beforeEach(() => { h.lookup.mockReset().mockResolvedValue([{ address: "8.8.4.4", family: 4 }]); });

describe("migration source SSH boundary", () => {
  it.each([
    { sshAuthMethod: "agent" }, { sshKeyPath: "/home/operator/.ssh/id_rsa" },
    { sshJumpHost: "internal-host" }, { sshArgs: "-o ProxyCommand=cat" },
    { sshTransport: "system" }, { isLocal: true }, { workspaceId: "another-user" },
  ])("rejects non-source connection options at the shared HTTP/MCP schema: %j", invalid => {
    expect(Value.Check(MigrationSourceInputSchema, { ...input, ...invalid })).toBe(false);
  });

  it("dials the validated IP and requires the saved host key", async () => {
    const config = await buildSshConfig(settings);
    expect(config).toMatchObject({ host: "8.8.4.4", password: "fixture-password" });
    const verify = config!.hostVerifier as (key: Buffer) => boolean;
    expect(verify(key)).toBe(true);
    expect(verify(Buffer.from("a different host"))).toBe(false);
  });

  it("revalidates DNS on reconnect and refuses private or mixed answers", async () => {
    expect(await buildSshConfig(settings)).toMatchObject({ host: "8.8.4.4" });
    h.lookup.mockResolvedValueOnce([{ address: "127.0.0.1", family: 4 }]);
    await expect(buildSshConfig(settings)).rejects.toMatchObject({ code: "SSRF_BLOCKED" });
    h.lookup.mockResolvedValueOnce([{ address: "8.8.4.4", family: 4 }, { address: "169.254.169.254", family: 4 }]);
    await expect(buildSshConfig(settings)).rejects.toMatchObject({ code: "SSRF_BLOCKED" });
  });

  it.each(["127.0.0.1", "169.254.169.254", "10.1.2.3", "::1", "::ffff:127.0.0.1", "localhost"])("does not connect to internal target %s", async host => {
    await expect(buildSshConfig({ ...settings, sshHost: host })).rejects.toThrow();
    expect(h.lookup).not.toHaveBeenCalled();
  });

  it("requires credentials and never falls back to an agent, key file, or local host", async () => {
    await expect(buildSshConfig({ ...settings, sshHostKey: undefined })).rejects.toThrow(/direct SSH/);
    await expect(buildSshConfig({ ...settings, sshKeyPath: "/tmp/key" })).rejects.toThrow(/direct SSH/);
    expect(await buildSshConfig({ ...settings, sshPassword: null })).toBeNull();
    expect(await isLocalHostRow({ ...settings, organizationId: "org", isLocal: true } as never)).toBe(false);
  });
});
