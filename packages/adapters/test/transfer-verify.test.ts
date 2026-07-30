import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { verifyExecutorTransfer } from "../src/runtime/transfer";
import { BuildLogger } from "../src/runtime/build-pipeline";
import type { CommandExecutor } from "../src/types";

const execFileAsync = promisify(execFile);

// `verifyExecutorTransfer` is the only guard between a silently-failed source
// transfer and the build. It shells out to `find`, so the assertions below run
// the real command against real directories - a mocked exec would happily
// return whatever count the test wanted and prove nothing about find's
// semantics, which is exactly where the bug lived.

/** Minimal executor that runs the command locally through a shell. */
function shellExecutor(): CommandExecutor {
  return {
    exec: async (command: string) => {
      const { stdout } = await execFileAsync("/bin/sh", ["-c", command]);
      return stdout;
    },
  } as unknown as CommandExecutor;
}

const logs: string[] = [];
const logger = new BuildLogger((entry) => {
  logs.push(entry.message);
});

let root: string;
let emptyDir: string;
let populatedDir: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "openship-transfer-"));
  emptyDir = join(root, "empty");
  populatedDir = join(root, "populated");
  await mkdir(emptyDir);
  await mkdir(populatedDir);
  await writeFile(join(populatedDir, "package.json"), "{}");
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("verifyExecutorTransfer", () => {
  it("throws when the target directory is empty", async () => {
    // Previously `find <dir> -maxdepth 1 -not -name '.'` listed the directory
    // itself, so the count was 1 and this guard could never fire.
    await expect(verifyExecutorTransfer(shellExecutor(), emptyDir, logger)).rejects.toThrow(
      /is empty - files were not copied/,
    );
  });

  it("passes when the target directory has content, and counts only its entries", async () => {
    logs.length = 0;
    await expect(
      verifyExecutorTransfer(shellExecutor(), populatedDir, logger),
    ).resolves.toBeUndefined();

    // One file in the directory => "1+", not "2+" (the directory itself used
    // to be counted alongside its contents).
    expect(logs.join("\n")).toContain("Transfer verified (1+ entries in target).");
  });

  it("still rejects when the target does not exist", async () => {
    // find's failure doesn't fail the pipeline (`wc -l` supplies the exit
    // code), so this lands on the same count-of-zero branch rather than the
    // "count command itself failed" one.
    await expect(
      verifyExecutorTransfer(shellExecutor(), join(root, "does-not-exist"), logger),
    ).rejects.toThrow(/files were not copied/);
  });

  it("handles a target path containing spaces and quotes", async () => {
    const odd = join(root, "we're here");
    await mkdir(odd);
    await expect(verifyExecutorTransfer(shellExecutor(), odd, logger)).rejects.toThrow(
      /is empty - files were not copied/,
    );

    await writeFile(join(odd, "index.html"), "<!doctype html>");
    await expect(verifyExecutorTransfer(shellExecutor(), odd, logger)).resolves.toBeUndefined();
  });
});
