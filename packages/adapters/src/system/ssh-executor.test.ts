import { afterEach, describe, expect, test } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { Server as SshServer, utils as sshUtils, type Connection, type Session } from "ssh2";

import { SshExecutor } from "./ssh-executor";

const { OPEN_MODE, STATUS_CODE } = sshUtils.sftp;

/**
 * A throwaway SSH server that mimics OpenSSH's `MaxSessions`: it counts
 * concurrently-open "session" channels (exec + SFTP subsystem alike) and
 * rejects new ones past `maxSessions`, exactly like real sshd does. It also
 * backs a minimal in-memory filesystem over the SFTP subsystem so writeFile/
 * readFile/exists can be exercised end-to-end.
 *
 * This is what let #34 (SFTP channel leak exhausting MaxSessions) reproduce
 * without Docker or enabling a real sshd: SshExecutor.writeFile/readFile/
 * exists used to open a brand-new `client.sftp()` channel per call and never
 * close it, so repeated file ops on one cached connection silently ate up
 * the server's session budget until every subsequent channel open — SFTP or
 * exec — started failing with "Channel open failure".
 */
function startMockSshd(maxSessions: number) {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });

  const files = new Map<string, Buffer>();
  let openCount = 0;
  let peakConcurrent = 0;
  let rejectedCount = 0;

  const server = new SshServer({ hostKeys: [privateKey] }, (client: Connection) => {
    client.on("authentication", (ctx) => ctx.accept());
    client.on("ready", () => {
      client.on("session", (accept, reject) => {
        if (openCount >= maxSessions) {
          rejectedCount++;
          reject();
          return;
        }
        openCount++;
        peakConcurrent = Math.max(peakConcurrent, openCount);
        const session: Session = accept();
        session.once("close", () => {
          openCount--;
        });

        // exec channels (used for `mkdir -p` before writeFile) close themselves
        // right away, freeing their slot — only the SFTP subsystem is long-lived.
        session.on("exec", (acceptExec) => {
          const stream = acceptExec();
          stream.exit(0);
          stream.end();
        });

        session.on("sftp", (acceptSftp) => {
          const sftpStream = acceptSftp();
          const handles = new Map<number, { path: string; data: Buffer }>();
          let nextHandle = 0;

          const toHandle = (n: number) => {
            const buf = Buffer.alloc(4);
            buf.writeUInt32BE(n, 0);
            return buf;
          };
          const fromHandle = (h: Buffer) => h.readUInt32BE(0);

          const attrsFor = (data: Buffer) => ({
            mode: 0o100644,
            size: data.length,
            uid: 0,
            gid: 0,
            atime: Math.floor(Date.now() / 1000),
            mtime: Math.floor(Date.now() / 1000),
          });

          sftpStream.on("OPEN", (reqid: number, filename: string, flags: number) => {
            const id = nextHandle++;
            if (flags & OPEN_MODE.WRITE) {
              handles.set(id, { path: filename, data: Buffer.alloc(0) });
            } else {
              const existing = files.get(filename);
              if (existing === undefined) {
                return sftpStream.status(reqid, STATUS_CODE.NO_SUCH_FILE);
              }
              handles.set(id, { path: filename, data: existing });
            }
            sftpStream.handle(reqid, toHandle(id));
          });

          sftpStream.on("WRITE", (reqid: number, handle: Buffer, offset: number, data: Buffer) => {
            const h = handles.get(fromHandle(handle));
            if (!h) return sftpStream.status(reqid, STATUS_CODE.FAILURE);
            const end = offset + data.length;
            if (h.data.length < end) {
              const grown = Buffer.alloc(end);
              h.data.copy(grown);
              h.data = grown;
            }
            data.copy(h.data, offset);
            sftpStream.status(reqid, STATUS_CODE.OK);
          });

          sftpStream.on("READ", (reqid: number, handle: Buffer, offset: number, length: number) => {
            const h = handles.get(fromHandle(handle));
            if (!h) return sftpStream.status(reqid, STATUS_CODE.FAILURE);
            if (offset >= h.data.length) return sftpStream.status(reqid, STATUS_CODE.EOF);
            sftpStream.data(reqid, h.data.subarray(offset, offset + length));
          });

          sftpStream.on("FSTAT", (reqid: number, handle: Buffer) => {
            const h = handles.get(fromHandle(handle));
            if (!h) return sftpStream.status(reqid, STATUS_CODE.FAILURE);
            sftpStream.attrs(reqid, attrsFor(h.data));
          });

          sftpStream.on("STAT", (reqid: number, path: string) => {
            const data = files.get(path);
            if (data === undefined) return sftpStream.status(reqid, STATUS_CODE.NO_SUCH_FILE);
            sftpStream.attrs(reqid, attrsFor(data));
          });
          sftpStream.on("LSTAT", (reqid: number, path: string) => {
            const data = files.get(path);
            if (data === undefined) return sftpStream.status(reqid, STATUS_CODE.NO_SUCH_FILE);
            sftpStream.attrs(reqid, attrsFor(data));
          });

          sftpStream.on("CLOSE", (reqid: number, handle: Buffer) => {
            const id = fromHandle(handle);
            const h = handles.get(id);
            if (h) {
              files.set(h.path, h.data);
              handles.delete(id);
            }
            sftpStream.status(reqid, STATUS_CODE.OK);
          });
        });
      });
    });
  });

  return new Promise<{
    port: number;
    close: () => void;
    peakConcurrent: () => number;
    rejectedCount: () => number;
    openCount: () => number;
  }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (typeof address === "string" || !address) throw new Error("no port");
      resolve({
        port: address.port,
        close: () => server.close(),
        peakConcurrent: () => peakConcurrent,
        rejectedCount: () => rejectedCount,
        openCount: () => openCount,
      });
    });
  });
}

/**
 * A throwaway SSH server for testing root cause #3 from #34: on this
 * connection, session channel #2 is deliberately refused ONCE (simulating
 * the server briefly rejecting a new channel — e.g. under session pressure
 * — even though the connection itself, and its OTHER open channels, are
 * perfectly healthy). Session #1 is a long-running exec (a stand-in for
 * `docker build`) that the server holds open well past that rejection.
 *
 * The pre-fix `withChannelRetry`/`streamExec` always called
 * `resetConnection()` (`client.end()`) on ANY channel-open failure — which
 * tears down every channel on the connection, including an unrelated
 * already-open one. This is what let a leaked SFTP channel error cancel an
 * in-flight `docker build` sharing the same cached connection.
 */
function startExecSurvivesMockSshd(execHoldMs: number) {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });

  let sessionSeq = 0;

  const server = new SshServer({ hostKeys: [privateKey] }, (client: Connection) => {
    client.on("authentication", (ctx) => ctx.accept());
    client.on("ready", () => {
      client.on("session", (accept, reject) => {
        sessionSeq++;
        const mySeq = sessionSeq;

        if (mySeq === 2) {
          reject();
          return;
        }

        const session: Session = accept();

        session.on("exec", (acceptExec) => {
          const stream = acceptExec();
          if (mySeq === 1) {
            // The long-running "build" — held open past the sibling
            // channel's rejection + retry below.
            setTimeout(() => {
              stream.write("build finished\n");
              stream.exit(0);
              stream.end();
            }, execHoldMs);
          } else {
            stream.exit(0);
            stream.end();
          }
        });

        session.on("sftp", (acceptSftp) => {
          const sftpStream = acceptSftp();
          sftpStream.on("STAT", (reqid: number) => {
            sftpStream.status(reqid, STATUS_CODE.NO_SUCH_FILE);
          });
        });
      });
    });
  });

  return new Promise<{ port: number; close: () => void }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (typeof address === "string" || !address) throw new Error("no port");
      resolve({ port: address.port, close: () => server.close() });
    });
  });
}

describe("SshExecutor SFTP channel reuse (regression for #34)", () => {
  let executor: SshExecutor | null = null;
  let mock: Awaited<ReturnType<typeof startMockSshd>> | null = null;

  afterEach(async () => {
    await executor?.dispose();
    mock?.close();
    executor = null;
    mock = null;
  });

  test("many exists() calls share ONE SFTP channel instead of leaking one per call", async () => {
    mock = await startMockSshd(2);
    executor = new SshExecutor({
      host: "127.0.0.1",
      port: mock.port,
      username: "root",
      password: "anything",
      hostVerifier: () => true,
    });

    // Prior to the fix, each exists() opened a fresh, never-closed SFTP
    // channel — the 3rd call here would have exceeded maxSessions=2 and
    // failed with "Channel open failure".
    for (let i = 0; i < 10; i++) {
      await expect(executor.exists(`/tmp/probe-${i}`)).resolves.toBe(false);
    }

    expect(mock.peakConcurrent()).toBe(1);
    expect(mock.rejectedCount()).toBe(0);
  });

  test("writeFile/readFile round-trip content while reusing the cached channel", async () => {
    mock = await startMockSshd(2);
    executor = new SshExecutor({
      host: "127.0.0.1",
      port: mock.port,
      username: "root",
      password: "anything",
      hostVerifier: () => true,
    });

    for (let i = 0; i < 5; i++) {
      const path = `/tmp/file-${i}.txt`;
      await executor.writeFile(path, `content-${i}`);
      await expect(executor.readFile(path)).resolves.toBe(`content-${i}`);
      await expect(executor.exists(path)).resolves.toBe(true);
    }

    // At most 2 concurrently open channels: the one cached SFTP subsystem
    // channel, plus (briefly) the exec channel for `mkdir -p` in writeFile.
    // Before the fix, this would grow unbounded — one leaked SFTP channel
    // per writeFile/readFile/exists call — and eventually exceed maxSessions.
    expect(mock.peakConcurrent()).toBeLessThanOrEqual(2);
    expect(mock.rejectedCount()).toBe(0);
  });

  test("dispose() frees the cached SFTP channel", async () => {
    mock = await startMockSshd(2);
    executor = new SshExecutor({
      host: "127.0.0.1",
      port: mock.port,
      username: "root",
      password: "anything",
      hostVerifier: () => true,
    });

    await executor.exists("/tmp/probe");
    expect(mock.openCount()).toBe(1);

    await executor.dispose();
    // ssh2 channel teardown is async — give the 'close' event a tick.
    await new Promise((r) => setTimeout(r, 50));
    expect(mock.openCount()).toBe(0);
  });
});

describe("SshExecutor channel-error recovery (regression for #34 root cause #3)", () => {
  let execExecutor: SshExecutor | null = null;
  let execMock: Awaited<ReturnType<typeof startExecSurvivesMockSshd>> | null = null;

  afterEach(async () => {
    await execExecutor?.dispose();
    execMock?.close();
    execExecutor = null;
    execMock = null;
  });

  test("a long-running exec survives a concurrent channel-open failure + retry on a sibling op", async () => {
    execMock = await startExecSurvivesMockSshd(400);
    execExecutor = new SshExecutor({
      host: "127.0.0.1",
      port: execMock.port,
      username: "root",
      password: "anything",
      hostVerifier: () => true,
    });

    const chunks: string[] = [];
    const buildPromise = execExecutor.streamExec("simulate-build", (entry) => chunks.push(entry.message));

    // Let the build's channel actually open before firing the sibling op.
    await new Promise((r) => setTimeout(r, 120));

    // exists()'s channel-open is rejected once (session #2 on the mock).
    // Pre-fix, withChannelRetry would unconditionally resetConnection() here
    // — client.end() — which tears down the build's still-open channel from
    // under it. Post-fix, since the build is still in flight, the retry
    // reuses the SAME connection instead.
    const existsResult = await execExecutor.exists("/tmp/probe");

    const build = await buildPromise;

    expect(build.code).toBe(0);
    expect(chunks.join("")).toContain("build finished");
    expect(existsResult).toBe(false);
  });
});
