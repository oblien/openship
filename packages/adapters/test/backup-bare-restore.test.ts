/**
 * The bare (mail-server) restore path, RUN through a real shell.
 *
 * Both bugs here were invisible to any assertion on the command's text, because both
 * were about what a shell does with that text:
 *
 *   1. `pipeIntoCommand` quoted an already-quoted script. ssh2 hands the string to the
 *      remote login shell, which unwraps one layer, so `sh -c` received the literal
 *      `'<script>'`, stripped those quotes, and tried to exec a command whose NAME was
 *      the whole multi-line script — exit 127, every mail restore, having done nothing.
 *      Capture was unaffected (execStream quotes exactly once), which is why it went
 *      unnoticed.
 *
 *   2. `receiveStream` cleared the target FIRST and then ran `zstd -d | tar -x`. A
 *      pipeline reports its LAST command's status and `tar -x` on an empty stream exits
 *      0, so a host without zstd got its maildirs deleted and the restore recorded as a
 *      success. The docker executor was fixed for exactly this; this copy was not.
 *
 * So these tests emulate the transport rather than describing it: the captured command
 * is executed with `/bin/sh -c`, which is what the remote login shell does with it.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { BareBackupExecutor } from "../src/backup/executors/bare";
import type { BareRuntime } from "../src/runtime/bare";
import type { ServiceHandle } from "../src/backup/types";

const service: ServiceHandle = {
  id: "svc_mail",
  projectId: "prj_mail",
  name: "mail",
  image: null,
  env: {},
  volumes: ["/var/vmail"],
  containerId: null,
  projectSlug: "mail",
  namespaceVolumes: false,
};

/**
 * A CommandExecutor stand-in that records the command string instead of dialling SSH.
 * `execWithInput` is the primitive the streaming path uses; `rawExec` only has to
 * exist for the executor's own guard.
 */
function fakeExec() {
  const captured: string[] = [];
  const exec = {
    rawExec: () => {
      throw new Error("not used in these tests");
    },
    execWithInput: async (command: string, body: Readable) => {
      captured.push(command);
      // Drain, so the producer side of a real restore would not stall.
      const chunks: Buffer[] = [];
      for await (const c of body) chunks.push(Buffer.from(c as Buffer));
      return { code: 0, stderr: "", stdout: "", input: Buffer.concat(chunks) };
    },
  };
  return { exec, captured };
}

function executorFor(exec: unknown): BareBackupExecutor {
  return new BareBackupExecutor({ commandExecutor: exec } as unknown as BareRuntime);
}

/**
 * A real gzip'd tar holding one file, so the extract has something to prove.
 *
 * The tar is gzipped with zlib rather than by `tar -cz`: BSD tar's own output leaves
 * padding after the gzip member, which makes `gzip -d` exit 2 on "trailing garbage"
 * and would fail these tests for a reason that has nothing to do with the code.
 */
function gzippedTar(contents: string): { archive: Buffer; name: string } {
  const stage = mkdtempSync(join(tmpdir(), "openship-bare-src-"));
  writeFileSync(join(stage, "vmail.txt"), contents);
  const out = spawnSync("tar", ["-c", "-C", stage, "."], { maxBuffer: 1 << 28 });
  expect(out.status, out.stderr?.toString()).toBe(0);
  return { archive: gzipSync(out.stdout), name: "vmail.txt" };
}

/** Run a captured command the way the remote login shell would. */
function runAsRemoteShell(command: string, input: Buffer, env?: NodeJS.ProcessEnv) {
  return spawnSync("/bin/sh", ["-c", command], {
    input,
    env: { ...process.env, ...env },
    maxBuffer: 1 << 28,
  });
}

describe("bare restore survives the transport's quoting", () => {
  it("actually extracts the archive instead of exiting 127", async () => {
    const target = mkdtempSync(join(tmpdir(), "openship-bare-dst-"));
    const { archive, name } = gzippedTar("hello maildir");
    const { exec, captured } = fakeExec();

    await executorFor(exec).receiveStream(service, target, Readable.from([archive]), {
      compression: "gzip",
      clearTarget: true,
    });

    expect(captured).toHaveLength(1);
    const run = runAsRemoteShell(captured[0], archive);
    // The regression: a doubly-quoted script came back 127 with the whole script
    // reported as an unknown command name.
    expect(run.status, run.stderr?.toString()).toBe(0);
    expect(readFileSync(join(target, name), "utf8")).toBe("hello maildir");
  });

  it("preserves a literal single quote in the target path", async () => {
    // The quoting is only correct if it survives a value that needs quoting. A path
    // with an apostrophe is the cheapest such value, and it is what broke every
    // hand-rolled escape this module used to carry.
    const base = mkdtempSync(join(tmpdir(), "openship-bare-q-"));
    const target = join(base, "it's mail");
    const { archive, name } = gzippedTar("quoted ok");
    const { exec, captured } = fakeExec();

    await executorFor(exec).receiveStream(service, target, Readable.from([archive]), {
      compression: "gzip",
      clearTarget: true,
    });

    const run = runAsRemoteShell(captured[0], archive);
    expect(run.status, run.stderr?.toString()).toBe(0);
    expect(readFileSync(join(target, name), "utf8")).toBe("quoted ok");
  });
});

describe("bare restore refuses to clear a target it cannot decompress into", () => {
  it("leaves existing data intact when the decompressor is missing", async () => {
    // The wipe-and-lie case, run for real. PATH is narrowed to a bin dir holding
    // only the tools the script legitimately needs, so `zstd` is genuinely absent —
    // asserting on the generated text could never have caught this, because the old
    // text was *valid*; it just deleted first and reported tar's exit 0.
    const bin = mkdtempSync(join(tmpdir(), "openship-bare-bin-"));
    for (const tool of ["mkdir", "rm", "tar", "cat", "env", "sh"]) {
      for (const dir of ["/bin", "/usr/bin"]) {
        const src = join(dir, tool);
        if (existsSync(src) && !existsSync(join(bin, tool))) {
          symlinkSync(src, join(bin, tool));
          break;
        }
      }
    }
    expect(existsSync(join(bin, "tar"))).toBe(true);

    const target = mkdtempSync(join(tmpdir(), "openship-bare-keep-"));
    mkdirSync(join(target, "Maildir"), { recursive: true });
    writeFileSync(join(target, "Maildir", "important.eml"), "do not delete me");

    const { exec, captured } = fakeExec();
    await executorFor(exec).receiveStream(service, target, Readable.from([Buffer.from("junk")]), {
      compression: "zstd",
      clearTarget: true,
    });

    const run = runAsRemoteShell(captured[0], Buffer.from("junk"), { PATH: bin });
    // Non-zero, and specifically our refusal code rather than a masked tar success.
    expect(run.status).not.toBe(0);
    expect(run.status).toBe(90);
    expect(run.stderr.toString()).toContain("your data is untouched");
    // The whole point: the maildir is still there.
    expect(readFileSync(join(target, "Maildir", "important.eml"), "utf8")).toBe(
      "do not delete me",
    );
    expect(readdirSync(target)).toContain("Maildir");
  });
});
