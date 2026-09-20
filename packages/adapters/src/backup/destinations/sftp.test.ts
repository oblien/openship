import { PassThrough, Readable, Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BackupDestination, BackupDestinationRow } from "../types";

const fake = vi.hoisted(() => ({
  mode: "success" as
    | "success"
    | "stream-failure"
    | "rename-failure"
    | "rename-hang"
    | "stream-close",
  sftp: undefined as unknown,
  unlinked: [] as string[],
  renamed: [] as Array<[string, string]>,
  cleanupHang: null as null | "handshake" | "unlink",
  channelHang: false,
  unlinkError: null as (Error & { code?: number }) | null,
  clients: [] as Array<{ emit(event: string, error?: Error): boolean; ended: boolean }>,
}));

vi.mock("ssh2", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    Client: class extends EventEmitter {
      ended = false;
      constructor() {
        super();
        fake.clients.push(this);
      }

      connect() {
        if (fake.cleanupHang === "handshake" && fake.clients.length > 1) return this;
        queueMicrotask(() => this.emit("ready"));
        return this;
      }

      sftp(callback: (error: Error | undefined, sftp: unknown) => void) {
        if (fake.channelHang) return;
        callback(undefined, fake.sftp);
      }

      end() {
        this.ended = true;
        this.emit("close");
      }
    },
  };
});

import "./sftp";
import { resolveDestination } from "../registry";

type TestWriteStream = Writable & { bytesWritten: number };

function makeSftp() {
  const sftp = {
    mkdir: vi.fn((_path: string, callback: (error?: Error | null) => void) => callback(null)),
    stat: vi.fn(),
    createWriteStream: vi.fn((_path: string) => {
      let stream: TestWriteStream;
      stream = new Writable({
        write(chunk: Buffer, _encoding, callback) {
          if (fake.mode === "stream-failure") {
            callback(new Error("upload failed"));
            return;
          }
          if (fake.mode === "stream-close") {
            stream.destroy();
            return;
          }
          stream.bytesWritten += chunk.byteLength;
          callback();
        },
      }) as TestWriteStream;
      stream.bytesWritten = 0;
      return stream;
    }),
    unlink: vi.fn((path: string, callback: (error?: Error | null) => void) => {
      fake.unlinked.push(path);
      if (fake.cleanupHang !== "unlink") callback(fake.unlinkError);
    }),
    rename: vi.fn((from: string, to: string, callback: (error?: Error | null) => void) => {
      fake.renamed.push([from, to]);
      if (fake.mode === "rename-hang") return;
      callback(fake.mode === "rename-failure" ? new Error("rename failed") : null);
    }),
  };
  fake.sftp = sftp;
  return sftp;
}

const row: BackupDestinationRow = {
  id: "dest_1",
  organizationId: "org_1",
  name: "Backup SFTP",
  kind: "sftp",
  endpoint: null,
  region: null,
  bucket: null,
  pathPrefix: "/backups",
  sshHost: "backup.example.test",
  sshPort: 22,
  sshUser: "backup",
  accessKeyIdEnc: null,
  secretAccessKeyEnc: null,
  sftpPasswordEnc: "password",
  sftpPrivateKeyEnc: null,
  sftpKeyPassphraseEnc: null,
};

beforeEach(() => {
  fake.mode = "success";
  fake.unlinked = [];
  fake.renamed = [];
  fake.cleanupHang = null;
  fake.channelHang = false;
  fake.unlinkError = null;
  fake.clients = [];
  vi.spyOn(console, "warn").mockImplementation(() => {});
  makeSftp();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("SFTP destination control deadlines and temporary uploads", () => {
  it("does not report a successful preflight when the probe stream closes early", async () => {
    fake.mode = "stream-close";
    expect(await resolveDestination(row).preflight()).toMatchObject({
      ok: false,
      reason: expect.stringContaining("before all bytes were written"),
    });
  });

  it.each(["channel", "directory"])("bounds a stalled %s before starting an upload", async (stage) => {
    vi.useFakeTimers();
    const sftp = makeSftp();
    if (stage === "channel") fake.channelHang = true;
    else sftp.mkdir.mockImplementation(() => {});
    const body = Readable.from(["payload"]);
    let failure: unknown;
    const pending = resolveDestination(row).put("artifact.zst", body, {}).catch((error) => {
      failure = error;
    });
    try {
      await vi.advanceTimersByTimeAsync(10_001);
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toContain("timed out");
      expect(body.destroyed).toBe(true);
      expect(sftp.createWriteStream).not.toHaveBeenCalled();
      expect(fake.clients.every((client) => client.ended)).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      fake.clients.forEach((client) => client.emit("close"));
      await pending;
    }
  });

  it("returns failed deletion keys when the server never acknowledges an unlink", async () => {
    vi.useFakeTimers();
    const sftp = makeSftp();
    sftp.unlink.mockImplementation((path, callback) => {
      if (path.endsWith("/stalled.zst")) return;
      callback(path.endsWith("/missing.zst") ? Object.assign(new Error("missing"), { code: 2 }) : null);
    });
    let result: Awaited<ReturnType<BackupDestination["deleteMany"]>> | undefined;
    const pending = resolveDestination(row)
      .deleteMany(["stalled.zst", "missing.zst", "healthy.zst"])
      .then((value) => { result = value; })
      .catch(() => {});
    try {
      await vi.advanceTimersByTimeAsync(10_001);
      expect(result).toEqual({
        deleted: ["missing.zst", "healthy.zst"],
        failed: [{ key: "stalled.zst", error: expect.stringContaining("timed out") }],
      });
      expect(fake.clients.every((client) => client.ended)).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      fake.clients.forEach((client) => client.emit("close"));
      await pending;
    }
  });

  it("removes the temporary file when the stream fails", async () => {
    fake.mode = "stream-failure";

    await expect(
      resolveDestination(row).put(
        "openship/project/service/run/artifact.tar.zst",
        Readable.from(["payload"]),
        {},
      ),
    ).rejects.toThrow("upload failed");

    expect(fake.renamed).toEqual([]);
    expect(fake.unlinked).toHaveLength(1);
    expect(fake.unlinked[0]).toMatch(/\.uploading-[0-9a-f]{8}$/);
  });

  it("removes the temporary file when finalization fails", async () => {
    fake.mode = "rename-failure";

    await expect(
      resolveDestination(row).put(
        "openship/project/service/run/artifact.tar.zst",
        Readable.from(["payload"]),
        {},
      ),
    ).rejects.toThrow("rename failed");

    expect(fake.renamed).toHaveLength(2);
    expect(fake.unlinked).toEqual([fake.renamed[0]![1], fake.renamed[0]![0]]);
  });

  it("renames the temporary file and keeps it on success", async () => {
    const result = await resolveDestination(row).put(
      "openship/project/service/run/artifact.tar.zst",
      Readable.from(["payload"]),
      {},
    );

    expect(result.bytesWritten).toBe(7);
    expect(fake.renamed).toHaveLength(1);
    expect(fake.renamed[0]?.[0]).toMatch(/\.uploading-[0-9a-f]{8}$/);
    expect(fake.renamed[0]?.[1]).toBe("/backups/openship/project/service/run/artifact.tar.zst");
    expect(fake.unlinked).toEqual([]);
    expect(fake.clients).toHaveLength(1);
  });

  it.each(["error", "close"])(
    "reconnects to clean up after the upload SSH connection emits %s",
    async (event) => {
      vi.useFakeTimers();
      const body = new PassThrough();
      let failure: unknown;
      const put = resolveDestination(row)
        .put("artifact.zst", body, {})
        .catch((error) => {
          failure = error;
        });
      await vi.advanceTimersByTimeAsync(1);
      fake.clients[0]!.emit(event, new Error("SSH disconnected"));
      await put;

      expect(failure).toBeInstanceOf(Error);
      expect(fake.unlinked[0]).toMatch(/artifact\.zst\.uploading-[0-9a-f]{8}$/);
      expect(fake.clients).toHaveLength(2);
      expect(fake.clients.every((client) => client.ended)).toBe(true);
      expect(body.destroyed).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each(["handshake", "unlink"] as const)(
    "bounds cleanup when the %s callback never arrives",
    async (stage) => {
      vi.useFakeTimers();
      fake.mode = "stream-failure";
      fake.cleanupHang = stage;
      let failure: unknown;
      const put = resolveDestination(row)
        .put("artifact.zst", Readable.from(["payload"]), {})
        .catch((error) => {
          failure = error;
        });
      await vi.advanceTimersByTimeAsync(10_001);

      expect(failure).toMatchObject({ message: "upload failed" });
      await put;
      expect(fake.clients.every((client) => client.ended)).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("cleans up and fails when final rename never acknowledges", async () => {
    vi.useFakeTimers();
    fake.mode = "rename-hang";
    let failure: unknown;
    const put = resolveDestination(row)
      .put("artifact.zst", Readable.from(["payload"]), {})
      .catch((error) => {
        failure = error;
      });
    await vi.advanceTimersByTimeAsync(10_001);

    expect(failure).toMatchObject({ message: "SFTP upload finalization timed out" });
    await put;
    expect(fake.unlinked).toEqual([fake.renamed[0]![0]]);
  });

  it("does not finalize a prematurely closed write stream", async () => {
    fake.mode = "stream-close";
    await expect(
      resolveDestination(row).put("artifact.zst", Readable.from(["payload"]), {}),
    ).rejects.toThrow("closed before all bytes were written");
    expect(fake.renamed).toEqual([]);
    expect(fake.unlinked).toHaveLength(1);
  });

  it("preserves source failures and treats an already absent temporary file as cleaned", async () => {
    fake.unlinkError = Object.assign(new Error("No such file"), { code: 2 });
    const body = new Readable({
      read() {
        this.destroy(new Error("source failed"));
      },
    });
    await expect(resolveDestination(row).put("artifact.zst", body, {})).rejects.toThrow(
      "source failed",
    );
    expect(fake.unlinked).toHaveLength(1);
    expect(console.warn).not.toHaveBeenCalled();
  });
});
