/**
 * `kind: 'local'` destinations were rejected on EVERY default install.
 *
 * The validator checked a deny list of system trees against the endpoint before
 * checking containment. `/var/lib/openship` is on that list and the default
 * BACKUP_LOCAL_ROOT is `/var/lib/openship/backups`, so every path inside the
 * configured root matched a denied prefix and threw — and the containment check
 * that followed was unreachable code.
 *
 * The deny list belongs on the ROOT: once an endpoint is contained by a root the
 * operator deliberately configured (behind BACKUP_ALLOW_LOCAL_DESTINATION), the
 * root IS the sandbox. Containment on the symlink-resolved path is what keeps an
 * endpoint from escaping it.
 */

import { mkdtemp, mkdir, symlink, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  assertLocalEndpointInRoot,
  resolveLocalBackupRoot,
} from "../../../src/modules/backup-destinations/local-path";

/** The shipped default (config/env.ts). The regression this file pins. */
const DEFAULT_ROOT = "/var/lib/openship/backups";

// macOS resolves /var → /private/var, so assert on the tail rather than an
// absolute string. The paths don't exist on a dev box either; the validator
// deliberately accepts a not-yet-created directory.
describe("local destination paths", () => {
  describe("the default root", () => {
    it("accepts the root itself", async () => {
      await expect(assertLocalEndpointInRoot(DEFAULT_ROOT, DEFAULT_ROOT)).resolves.toMatch(
        /\/lib\/openship\/backups$/,
      );
    });

    it("accepts a subpath of it", async () => {
      await expect(
        assertLocalEndpointInRoot(`${DEFAULT_ROOT}/acme/prod`, DEFAULT_ROOT),
      ).resolves.toMatch(/\/lib\/openship\/backups\/acme\/prod$/);
    });

    it("is itself a valid root, despite living under /var/lib/openship", async () => {
      await expect(resolveLocalBackupRoot(DEFAULT_ROOT)).resolves.toMatch(
        /\/lib\/openship\/backups$/,
      );
    });
  });

  describe("escaping the root", () => {
    it("rejects a sibling directory", async () => {
      await expect(
        assertLocalEndpointInRoot("/var/lib/openship/db", DEFAULT_ROOT),
      ).rejects.toThrow(/inside BACKUP_LOCAL_ROOT/);
    });

    it("rejects a traversal that climbs out", async () => {
      await expect(
        assertLocalEndpointInRoot(`${DEFAULT_ROOT}/../../../etc`, DEFAULT_ROOT),
      ).rejects.toThrow(/inside BACKUP_LOCAL_ROOT/);
    });

    it("rejects a prefix-sharing sibling that is not a child", async () => {
      // "/var/lib/openship/backups-evil" starts with the root STRING but is not
      // inside it. The separator in the comparison is what catches this.
      await expect(
        assertLocalEndpointInRoot(`${DEFAULT_ROOT}-evil`, DEFAULT_ROOT),
      ).rejects.toThrow(/inside BACKUP_LOCAL_ROOT/);
    });

    it("rejects a relative path", async () => {
      await expect(assertLocalEndpointInRoot("backups/acme", DEFAULT_ROOT)).rejects.toThrow(
        /must be absolute/,
      );
    });
  });

  describe("a dangerous root", () => {
    it.each(["/etc", "/etc/openship", "/var/lib/docker/volumes", "/proc", "/boot"])(
      "rejects %s",
      async (root) => {
        await expect(resolveLocalBackupRoot(root)).rejects.toThrow(
          /protected system directory/,
        );
      },
    );

    it.each(["/", "/var", "/var/lib", "/var/lib/openship"])(
      "rejects %s as too broad or reserved",
      async (root) => {
        await expect(resolveLocalBackupRoot(root)).rejects.toThrow(
          /not a valid backup root/,
        );
      },
    );

    it("rejects a relative root", async () => {
      await expect(resolveLocalBackupRoot("var/backups")).rejects.toThrow(
        /must be an absolute path/,
      );
    });

    it("rejects an unset root", async () => {
      await expect(resolveLocalBackupRoot("  ")).rejects.toThrow(/not configured/);
    });
  });

  // Symlinks need a real filesystem, so these use a temp root.
  describe("symlinks (real filesystem)", () => {
    let tmpRoot: string;
    let realRoot: string;

    beforeAll(async () => {
      tmpRoot = await mkdtemp(path.join(tmpdir(), "openship-bkp-"));
      realRoot = path.join(tmpRoot, "root");
      await mkdir(path.join(realRoot, "inside"), { recursive: true });
      await mkdir(path.join(tmpRoot, "outside"), { recursive: true });
      await symlink(path.join(tmpRoot, "outside"), path.join(realRoot, "escape"));
      await symlink(path.join(realRoot, "inside"), path.join(realRoot, "loop-back"));
    });

    afterAll(async () => {
      await rm(tmpRoot, { recursive: true, force: true });
    });

    it("rejects a symlink that leaves the root", async () => {
      await expect(
        assertLocalEndpointInRoot(path.join(realRoot, "escape"), realRoot),
      ).rejects.toThrow(/inside BACKUP_LOCAL_ROOT/);
    });

    it("rejects a path UNDER a symlink that leaves the root", async () => {
      await expect(
        assertLocalEndpointInRoot(path.join(realRoot, "escape", "acme"), realRoot),
      ).rejects.toThrow(/inside BACKUP_LOCAL_ROOT/);
    });

    it("accepts a symlink that stays inside the root", async () => {
      await expect(
        assertLocalEndpointInRoot(path.join(realRoot, "loop-back"), realRoot),
      ).resolves.toBe(await realpath(path.join(realRoot, "inside")));
    });

    it("accepts a not-yet-created subdirectory", async () => {
      const target = path.join(realRoot, "inside", "does", "not", "exist", "yet");
      await expect(assertLocalEndpointInRoot(target, realRoot)).resolves.toContain(
        "exist",
      );
    });

    it("accepts a root reached through a symlink", async () => {
      const linkedRoot = path.join(tmpRoot, "root-link");
      await symlink(realRoot, linkedRoot);
      await expect(
        assertLocalEndpointInRoot(path.join(linkedRoot, "inside"), linkedRoot),
      ).resolves.toBe(await realpath(path.join(realRoot, "inside")));
    });
  });
});
