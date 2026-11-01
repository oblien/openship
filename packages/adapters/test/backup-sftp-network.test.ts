import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BackupDestinationRow } from "../src/backup/types";

const h = vi.hoisted(() => ({ lookup: vi.fn(), connect: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup: h.lookup }));
vi.mock("ssh2", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    Client: class extends EventEmitter {
      connect(config: { hostVerifier?: (key: Buffer) => boolean }) {
        h.connect(config);
        queueMicrotask(() => {
          if (config.hostVerifier && !config.hostVerifier(Buffer.from("test-host-key"))) {
            this.emit("error", new Error("Host key verification failed"));
          } else this.emit("ready");
        });
        return this;
      }
      sftp(callback: Function) {
        callback(null, {
          stat: (_path: string, done: Function) => done(null, { size: 0, mtime: 0 }),
        });
      }
      end() {
        this.emit("close");
      }
    },
  };
});
import "../src/backup/destinations/sftp";
import { resolveDestination } from "../src/backup/registry";

const row = {
  id: "backup",
  organizationId: "tenant",
  name: "backup",
  kind: "sftp",
  sshHost: "storage.example.test",
  sshUser: "backup",
  sftpPasswordEnc: "test-only",
  pathPrefix: "/backups",
  publicNetworkOnly: true,
} as BackupDestinationRow;
beforeEach(() => {
  vi.resetAllMocks();
});

describe("SFTP destination connection policy", () => {
  it("preserves a server's pinned host identity after resolving its public address", async () => {
    h.lookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    await expect(
      resolveDestination({
        ...row,
        sshHostKey: Buffer.from("test-host-key").toString("base64"),
      }).head("file"),
    ).resolves.toBeTruthy();
    await expect(
      resolveDestination({
        ...row,
        sshHostKey: Buffer.from("different-host-key").toString("base64"),
      }).head("file"),
    ).rejects.toThrow("Host key verification failed");
  });
  it("dials only the checked public IP, without a second DNS lookup", async () => {
    h.lookup.mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }]);
    await resolveDestination(row).head("file");
    expect(h.lookup).toHaveBeenCalledOnce();
    expect(h.connect).toHaveBeenCalledWith(expect.objectContaining({ host: "93.184.216.34" }));
  });
  it.each(["127.0.0.1", "10.0.0.1", "169.254.169.254", "::1", "::ffff:127.0.0.1"])(
    "refuses %s before SSH receives credentials",
    async (address) => {
      h.lookup.mockResolvedValue([{ address, family: address.includes(":") ? 6 : 4 }]);
      await expect(resolveDestination(row).head("file")).rejects.toMatchObject({
        code: "SSRF_BLOCKED",
      });
      expect(h.connect).not.toHaveBeenCalled();
    },
  );
  it("retains self-hosted LAN connections", async () => {
    await resolveDestination({ ...row, sshHost: "10.0.0.1", publicNetworkOnly: false }).head(
      "file",
    );
    expect(h.connect).toHaveBeenCalledWith(expect.objectContaining({ host: "10.0.0.1" }));
    expect(h.lookup).not.toHaveBeenCalled();
  });
});
