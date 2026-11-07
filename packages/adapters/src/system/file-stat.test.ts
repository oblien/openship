import { describe, expect, it } from "vitest";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fileStatOf } from "./file-stat";
import { LocalExecutor } from "./local-executor";
import { SshExecutor } from "./ssh-executor";

describe("fileStatOf", () => {
  it.each([
    [0o100600, { kind: "file", mode: 0o600 }],
    [0o100644, { kind: "file", mode: 0o644 }],
    [0o120777, { kind: "symlink", mode: 0o777 }],
    [0o040755, { kind: "directory", mode: 0o755 }],
    [0o010644, { kind: "other", mode: 0o644 }],
  ])("maps st_mode %o", (mode, expected) => {
    expect(fileStatOf({ mode })).toEqual(expected);
  });
});

describe("LocalExecutor.lstat", () => {
  it("reports type and mode without following a symlink, and null for a missing path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openship-lstat-"));
    try {
      const file = join(dir, "a.conf");
      await writeFile(file, "x", { mode: 0o600 });
      await symlink(file, join(dir, "link.conf"));
      const local = new LocalExecutor();
      expect(await local.lstat(file)).toEqual({ kind: "file", mode: 0o600 });
      expect((await local.lstat(join(dir, "link.conf")))?.kind).toBe("symlink");
      expect(await local.lstat(join(dir, "missing.conf"))).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("SshExecutor.lstat", () => {
  /** The SFTP plumbing reduced to its callback contract. */
  function overSftp(reply: (path: string) => { err?: { code?: number }; mode?: number }) {
    const sftp = {
      lstat: (path: string, cb: (err: unknown, attrs: { mode: number }) => void) => {
        const { err, mode } = reply(path);
        cb(err ?? null, { mode: mode ?? 0 });
      },
    };
    const self = {
      client: {},
      withChannelRetry: <T>(fn: () => Promise<T>) => fn(),
      sftp: async () => sftp,
      runSftpRequest: <T>(
        _client: unknown,
        channel: typeof sftp,
        _operation: string,
        start: (done: (error?: Error | null, value?: T) => void) => void,
      ) => {
        void channel;
        return new Promise<T>((resolve, reject) =>
          start((error, value) => (error ? reject(error) : resolve(value as T))),
        );
      },
    };
    return (path: string) => SshExecutor.prototype.lstat.call(self as never, path);
  }

  it("maps attrs to a FileStat", async () => {
    expect(await overSftp(() => ({ mode: 0o100600 }))("/x.conf")).toEqual({
      kind: "file",
      mode: 0o600,
    });
  });

  it("answers null only for SSH_FX_NO_SUCH_FILE", async () => {
    expect(await overSftp(() => ({ err: { code: 2 } }))("/x.conf")).toBeNull();
  });

  it("rejects a refusal instead of calling the path absent", async () => {
    const refused = Object.assign(new Error("Permission denied"), { code: 3 });
    await expect(overSftp(() => ({ err: refused }))("/x.conf")).rejects.toThrow(
      "Permission denied",
    );
  });
});
