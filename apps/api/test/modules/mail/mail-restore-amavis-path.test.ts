import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { buildMailBackupPayload } from "../../../src/modules/mail/admin/backup-plan";

/**
 * A restored amavis config has to land where THIS box's amavis reads it.
 *
 * Restoring is normally cross-machine — that is the point of a backup — so source and
 * target routinely disagree about where amavis keeps its editable config: Debian has an
 * include dir (`/etc/amavis/conf.d/50-user`), the RHEL family a monolithic
 * `/etc/amavisd.conf`. The archive records the path it came from, and honouring that
 * verbatim writes a file the target's amavis never opens — `cp -a … || true` succeeds, the
 * restore reports success, and the config silently does nothing.
 *
 * These run the REAL emitted shell rather than asserting on its text, with the candidate
 * paths rebased under a temp root: the rule is a chain of `test`s, and a string assertion
 * cannot tell a correct chain from a plausible one. It also pins the direction that is easy
 * to get wrong — on Debian the destination FILE legitimately does not exist yet (50-user is
 * ours to create), so a probe keyed on the file instead of the include DIRECTORY reads a
 * Debian box as "no amavis here" and falls through to the RHEL path.
 */

const DEBIAN = "/etc/amavis/conf.d/50-user";
const DEBIAN_DIR = "/etc/amavis/conf.d";
const RHEL = "/etc/amavisd.conf";
const CONTENT = "$final_spam_destiny = D_DISCARD;\n";

/**
 * The amavis placement block of the real restore script, rebased under `root`.
 *
 * Sliced between two stable markers rather than by line number, so an edit elsewhere in the
 * restore cannot silently shrink what is under test — a missing marker fails loudly here
 * instead of passing vacuously.
 */
function placementScript(root: string, tmp: string): string {
  const script = buildMailBackupPayload("example.com", {
    messageData: false,
    keys: true,
  }).payloadConfig.restoreCommand;

  const start = script.indexOf('dest=""');
  const end = script.indexOf('if [ -d "$tmp/vmail1" ]');
  expect(start, "restore script no longer resolves an amavis `dest`").toBeGreaterThan(-1);
  expect(end, "restore script has no maildir step to slice against").toBeGreaterThan(start);

  const block = script.slice(start, end);
  expect(block).toContain("cp -a");
  // Every absolute path in this block is an /etc one, and nothing else in it is.
  return `set -e\ntmp=${JSON.stringify(tmp)}\n${block.replaceAll("/etc/", `${root}/etc/`)}`;
}

/** Stage an archive + a target layout, run the placement, report where the file went. */
function place(opts: {
  /** Pre-existing amavis config on the TARGET, or none at all. */
  target: "debian" | "rhel" | "none";
  /** Path the ARCHIVE says it came from; null for a legacy archive that records none. */
  archiveFrom: string | null;
  legacyName?: boolean;
}): { at: (p: string) => boolean; read: (p: string) => string } {
  const root = mkdtempSync(join(tmpdir(), "amavis-target-"));
  const tmp = mkdtempSync(join(tmpdir(), "amavis-archive-"));

  mkdirSync(join(root, "etc"), { recursive: true });
  if (opts.target === "debian") mkdirSync(join(root, DEBIAN_DIR), { recursive: true });
  if (opts.target === "rhel") writeFileSync(join(root, RHEL), "# the target's own\n");

  mkdirSync(join(tmp, "keys"), { recursive: true });
  writeFileSync(join(tmp, opts.legacyName ? "keys/amavis-50-user" : "keys/amavis-conf"), CONTENT);
  if (opts.archiveFrom) {
    // A real archive names a path in the SOURCE box's namespace, and the candidate list the
    // script matches it against is rebased — so a known path has to be rebased too, or the
    // fallback could never match its own list and every case would test the same branch.
    // An unknown path is left alone: not matching is the whole point of it.
    const recorded = opts.archiveFrom.startsWith("/etc/")
      ? join(root, opts.archiveFrom)
      : opts.archiveFrom;
    writeFileSync(join(tmp, "keys/amavis-conf.path"), recorded);
  }

  execFileSync("sh", ["-c", placementScript(root, tmp)], { stdio: "pipe" });

  return {
    at: (p) => existsSync(join(root, p)),
    read: (p) => readFileSync(join(root, p), "utf8"),
  };
}

describe("a restored amavis config lands where the TARGET reads it", () => {
  it("writes the RHEL path on a RHEL target, even from a Debian archive", () => {
    const r = place({ target: "rhel", archiveFrom: DEBIAN });

    expect(r.read(RHEL)).toBe(CONTENT);
    // The source's path must not be recreated: a file there is one this box's amavis will
    // never open, and its presence is what made the failure look like a success.
    expect(r.at(DEBIAN)).toBe(false);
  });

  it("writes the include file on a Debian target, even from a RHEL archive", () => {
    // The direction a file-existence probe gets wrong: 50-user is ours to CREATE, so the
    // only evidence a Debian box offers is the include DIRECTORY.
    const r = place({ target: "debian", archiveFrom: RHEL });

    expect(r.read(DEBIAN)).toBe(CONTENT);
    expect(r.at(RHEL)).toBe(false);
  });

  it("falls back to the archive's recorded path when the target has no amavis", () => {
    // Nothing to probe, so the source is the best evidence left.
    const r = place({ target: "none", archiveFrom: RHEL });

    expect(r.read(RHEL)).toBe(CONTENT);
    expect(r.at(DEBIAN)).toBe(false);
  });

  it("never writes a path the archive invented", () => {
    // This shell runs as root on the target, so the recorded path is matched against the
    // known candidates rather than used — otherwise `cp -a` is an arbitrary root write.
    // With no amavis to probe and no usable recorded path, nothing is placed at all: the
    // default's include dir doesn't exist on such a box and `|| true` absorbs the miss.
    const r = place({ target: "none", archiveFrom: "/tmp/openship-amavis-escape/authorized_keys" });

    expect(existsSync("/tmp/openship-amavis-escape/authorized_keys")).toBe(false);
    expect(r.at(RHEL)).toBe(false);
    expect(r.at(DEBIAN)).toBe(false);
  });

  it("places a legacy archive by the target's layout, since it records no source", () => {
    // Pre-2026-08 archives carried the Debian path under a fixed name with no `.path`
    // sidecar, so the target probe is the only thing that can place them at all.
    const r = place({ target: "rhel", archiveFrom: null, legacyName: true });

    expect(r.read(RHEL)).toBe(CONTENT);
    expect(r.at(DEBIAN)).toBe(false);
  });
});
