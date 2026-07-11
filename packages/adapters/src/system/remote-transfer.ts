import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";

import { formatBytes } from "@repo/core";
import { getTarCreateEnv } from "../archive";
import type { LogEntry } from "../types";
import { logEntry, sq } from "./local-shell";

/**
 * Shared helpers for the single-archive source transfer: pack the tree into ONE
 * file locally, then extract that one file on the remote. The upload itself is
 * the executor's own native fast path (ssh2 SFTP `fastPut`, or a `cat` stream
 * over the OpenSSH ControlMaster) — rsync is deliberately gone: it delta-syncs a
 * directory against an existing copy, which buys nothing when sending a single
 * fresh archive to a freshly-cleaned remote (it only adds a separate ssh
 * subprocess, an `sshpass` dependency, and a second auth path that can desync).
 */

type LogCallback = (log: LogEntry) => void;

/**
 * Run `tar` locally, streaming its archive to `outFile`. Resolves when tar
 * exits 0 AND the file is fully flushed; rejects with tar's stderr otherwise.
 */
export function packLocalArchive(tarArgs: string[], outFile: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const tar = spawn("tar", tarArgs, { stdio: ["ignore", "pipe", "pipe"], env: getTarCreateEnv() });
    const out = createWriteStream(outFile);
    let stderr = "";
    let tarCode: number | null = null;
    let tarClosed = false;
    let outClosed = false;
    const settle = () => {
      if (!tarClosed || !outClosed) return;
      if (tarCode === 0) resolve();
      else reject(new Error(`tar failed (exit ${tarCode})${stderr.trim() ? `: ${stderr.trim().slice(-300)}` : ""}`));
    };
    tar.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    tar.on("error", reject);
    out.on("error", reject);
    tar.stdout.pipe(out);
    tar.on("close", (code) => {
      tarCode = code ?? 1;
      tarClosed = true;
      settle();
    });
    out.on("finish", () => {
      outClosed = true;
      settle();
    });
  });
}

/**
 * Finish a single-file transfer on the remote: verify the uploaded archive is
 * exactly the size we sent (catches a silently-truncated stream that still
 * exited 0), extract it, and ALWAYS remove the archive afterward — even if tar
 * fails, so a corrupt upload never litters the server. Throws on size mismatch
 * or a non-zero tar, propagating tar's exit code.
 *
 * `exec` runs a command on the remote and resolves with its stdout (rejecting on
 * non-zero exit) — i.e. the executor's own `exec`.
 */
export async function extractRemoteArchive(
  exec: (command: string) => Promise<string>,
  remoteArchive: string,
  remotePath: string,
  expectedBytes: number,
  onLog?: LogCallback,
): Promise<void> {
  const received = Number((await exec(`wc -c < ${sq(remoteArchive)}`)).trim());
  if (received !== expectedBytes) {
    await exec(`rm -f ${sq(remoteArchive)}`).catch(() => {});
    throw new Error(`upload truncated: sent ${expectedBytes} bytes, server received ${received}`);
  }
  await exec(
    `mkdir -p ${sq(remotePath)} && tar xzf ${sq(remoteArchive)} -C ${sq(remotePath)}; rc=$?; rm -f ${sq(remoteArchive)}; exit $rc`,
  );
  onLog?.(logEntry(`Transferred ${formatBytes(expectedBytes)} and extracted on the server.`));
}
