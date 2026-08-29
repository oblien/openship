import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { packBuildContext } from "../src/runtime/docker";

/**
 * Regression for #448: a folder deploy of a large monorepo took down the WHOLE
 * control-plane process. dockerode builds the build-context tar with tar-fs
 * internally and never attaches an 'error' listener, so when the tar walk hits a
 * file that readdir listed but lstat can no longer find — a temp/AV/editor race,
 * or (the repro) our own premature context cleanup deleting the dir mid-upload —
 * the Pack emits an unhandled 'error' and crashes the API.
 *
 * packBuildContext owns the pack so that error is captured, the in-flight build
 * request is aborted, and only the deploy fails. These tests drive the pack the
 * same way the daemon upload does (the stream must FLOW for tar-fs to walk) and
 * assert the crash can't happen: the missing-entry case is the exact ENOENT lstat
 * the issue reports.
 */
describe("packBuildContext — build-context tar (#448)", () => {
  it("packs a real context into a gzip tar without error", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openship-ctx-ok-"));
    try {
      await writeFile(join(dir, "real.txt"), "hello");

      const { body, abortSignal, takeError } = packBuildContext(dir, ["real.txt"]);
      const chunks: Buffer[] = [];
      for await (const chunk of body) chunks.push(chunk as Buffer);
      const buf = Buffer.concat(chunks);

      expect(takeError()).toBeNull();
      expect(abortSignal.aborted).toBe(false);
      expect(buf.length).toBeGreaterThan(0);
      // gzip magic — proves this is byte-compatible with dockerode's own upload.
      expect(buf[0]).toBe(0x1f);
      expect(buf[1]).toBe(0x8b);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("captures a mid-walk lstat ENOENT and aborts instead of crashing the process", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openship-ctx-enoent-"));
    try {
      await writeFile(join(dir, "real.txt"), "hello");

      // A vanished entry: readdir listed it, lstat can't find it — the #448 race.
      const { body, abortSignal, takeError } = packBuildContext(dir, ["ghost.txt"]);

      // Drive the stream so tar-fs actually walks (and thus lstats) the entry.
      // If the pack error were unhandled this consumption would throw an
      // uncaught 'error' and take the worker down; it must not.
      body.on("data", () => {});
      await new Promise<void>((resolve) => {
        if (abortSignal.aborted) return resolve();
        abortSignal.addEventListener("abort", () => resolve(), { once: true });
        setTimeout(resolve, 3000);
      });

      expect(abortSignal.aborted).toBe(true);
      const err = takeError();
      expect(err).toBeInstanceOf(Error);
      expect(err?.message).toMatch(/ENOENT|no such file/i);

      body.destroy();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
