/**
 * A volume capture must not record an archive of nothing as a backup.
 *
 * The daemon CREATES a missing bind directory and a missing named volume when it
 * honors `HostConfig.Binds`. So a source that is not on the host — an external disk
 * that failed to mount, a data directory renamed under a still-running container, a
 * volume `docker system prune --volumes` took — produced a helper that started fine
 * and a `tar -c` of an empty mount that exited 0.
 *
 * Nothing downstream could tell that apart from a real backup: an empty tar is 10240
 * bytes and ~350 compressed, so the orchestrator's only emptiness guard
 * (`sizeBytes === 0`) passed, and the producer's guards only cover "no sources listed
 * at all", never "the source turned out to be empty".
 *
 * Two halves are asserted, because either alone is a false pass: that the generated
 * command CARRIES the gate, and that the gate actually does what it claims when a
 * real shell runs it.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { FakeAttachStream, harness } from "./helpers/docker-helper-harness";
import type { ServiceHandle } from "../src/backup/types";

const attachControl: { stream: FakeAttachStream | null } = { stream: null };

// Partial mock: the executor also imports `daemonConnectionFrom` from this module.
vi.mock(import("../src/runtime/docker-exec-stream"), async (importOriginal) => ({
  ...(await importOriginal()),
  startAttachStream: async () => attachControl.stream as never,
  startExecStream: async () => attachControl.stream as never,
}));

const SERVICE: ServiceHandle = {
  id: "svc_1",
  projectId: "prj_1",
  name: "db",
  image: "postgres:16",
  env: {},
  volumes: ["pgdata:/var/lib/postgresql/data"],
  containerId: null,
  projectSlug: "shop",
  namespaceVolumes: false,
};

beforeEach(() => {
  attachControl.stream = new FakeAttachStream();
});
afterEach(() => {
  vi.restoreAllMocks();
});

/** The helper command the executor asked the daemon to run. */
async function capturedCmd(compression: "none" | "zstd" | "gzip"): Promise<string> {
  const h = harness({ wait: 0 }, () => ({}));
  const exec = await h.executor();
  const { stdout, awaitExit } = await exec.streamPath(SERVICE, "pgdata-0", { compression });
  stdout.on("data", () => {});
  stdout.on("error", () => {});
  attachControl.stream!.end?.();
  await awaitExit.catch(() => {});
  const spec = h.created.at(-1) as { Cmd?: string[] } | undefined;
  expect(spec?.Cmd, JSON.stringify(h.created)).toBeTruthy();
  return (spec!.Cmd as string[]).join("\n");
}

describe("the capture command carries an empty-source gate", () => {
  it("gates every codec, not just the compressed ones", async () => {
    // `none` and `gzip` skip the pipeline entirely (busybox tar compresses in
    // process) and take a different branch of safeDumpCommand, so a gate added only
    // to the zstd prelude would leave the other two silently backing up nothing.
    for (const compression of ["none", "gzip", "zstd"] as const) {
      const cmd = await capturedCmd(compression);
      expect(cmd, compression).toContain("ls -A /mnt");
      expect(cmd, compression).toContain("exit 91");
      // The source id is named, because "something was empty" is not actionable.
      expect(cmd, compression).toContain("pgdata-0");
    }
  });

  it("runs the gate BEFORE installing the compressor", async () => {
    // Ordering is not cosmetic: `apk add zstd` costs ~20s per helper and needs
    // network egress, so paying it for a capture that cannot produce anything is
    // pure latency on the failure path.
    const cmd = await capturedCmd("zstd");
    expect(cmd.indexOf("ls -A /mnt")).toBeLessThan(cmd.indexOf("apk add"));
  });
});

describe("the gate refuses an empty mount and passes a populated one", () => {
  /** The gate as generated, with /mnt pointed at a real directory. */
  const gateFor = (dir: string) =>
    [
      `SRC='pgdata-0'`,
      `[ -n "$(ls -A ${dir} 2>/dev/null)" ] || { echo "openship: backup source $SRC is empty` +
        ` or missing on this host" >&2; exit 91; }`,
      `tar -c -C ${dir} . | wc -c`,
    ].join("\n");

  it("exits 91 on an empty directory", () => {
    const empty = mkdtempSync(join(tmpdir(), "openship-empty-src-"));
    const run = spawnSync("/bin/sh", ["-c", gateFor(empty)]);
    expect(run.status).toBe(91);
    expect(run.stderr.toString()).toContain("empty or missing");
  });

  it("exits 91 on a path that does not exist at all", () => {
    // What the daemon would have CREATED for us, silently.
    const missing = join(tmpdir(), "openship-definitely-not-here-9f2c1");
    const run = spawnSync("/bin/sh", ["-c", gateFor(missing)]);
    expect(run.status).toBe(91);
  });

  it("passes a directory with content", () => {
    const full = mkdtempSync(join(tmpdir(), "openship-full-src-"));
    writeFileSync(join(full, "pg_control"), "real data");
    const run = spawnSync("/bin/sh", ["-c", gateFor(full)]);
    expect(run.status, run.stderr?.toString()).toBe(0);
    // A byte count proves nothing here — tar's default 10240-byte blocking means a
    // small file archives to exactly the same size as nothing at all, which is the
    // reason the zero-byte guard could not tell them apart. Assert the CONTENT.
    const listed = spawnSync("/bin/sh", ["-c", `tar -t -C ${full} -f - < /dev/null; tar -c -C ${full} . | tar -t`]);
    expect(listed.stdout.toString()).toContain("pg_control");
  });

  it("shows why the zero-byte check could never have caught this", () => {
    // An empty tar is a VALID archive of 10240 bytes, so `sizeBytes === 0` passes.
    // This is the number that made the old behaviour indistinguishable from a real
    // backup, asserted so nobody re-derives it.
    const empty = mkdtempSync(join(tmpdir(), "openship-empty-tar-"));
    const run = spawnSync("/bin/sh", ["-c", `tar -c -C ${empty} . | wc -c`]);
    expect(run.status).toBe(0);
    expect(Number(run.stdout.toString().trim())).toBe(10240);
  });
});
