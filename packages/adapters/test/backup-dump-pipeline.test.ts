/**
 * The two silent-success holes on the producer side, and the key layout that made a
 * real backup impossible to find.
 *
 * All three are the same class as [#611](https://github.com/oblien/openship/issues/611):
 * the run said it worked.
 *
 *  1. `<dump> | zstd` exits with ZSTD's status, so a failed dump was reported as a
 *     successful backup — over an artifact that is small but not empty, which is the
 *     one shape the "0 bytes = failed" backstop cannot catch.
 *  2. The codec was assumed present in the user's own database container. It is not
 *     on a stock `postgres:*-alpine`, and a missing compressor was invisible for
 *     reason (1).
 *  3. `runPrefix` prepended the destination's `pathPrefix`, which the destination
 *     then prepended again — so the recorded `objectKeyPrefix` named a location that
 *     held nothing.
 *
 * The generated shell is asserted by RUNNING it under `/bin/sh`, not by matching its
 * text: the whole point is what the shell does with the file descriptors, and a
 * string assertion would have passed against the broken version too.
 */

import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import {
  codecSuffix,
  decompressor,
  recordedCodec,
  safeDumpCommand,
  safeRestoreCommand,
} from "../src/backup/common/dump-pipeline";
import { artifactKey, manifestKey, runPrefix } from "../src/backup/common/key-builder";

/**
 * Run a generated `["sh","-c",script]` and report status + raw stdout.
 *
 * `spawnSync` and not async `execFile`: the restore direction needs bytes ON STDIN,
 * `execFile` has no `input` option (only the *Sync* variants do), and a decompressor
 * whose stdin never closes waits forever. Buffers throughout, because a compressed
 * payload is not text — decoding it as utf8 corrupts the bytes before the loader
 * ever sees them.
 */
function run(argv: string[], stdin?: Buffer): { code: number; stdout: Buffer; stderr: string } {
  const res = spawnSync(argv[0]!, argv.slice(1), { input: stdin, maxBuffer: 1 << 20 });
  return {
    code: res.status ?? 1,
    stdout: res.stdout ?? Buffer.alloc(0),
    stderr: (res.stderr ?? Buffer.alloc(0)).toString("utf8"),
  };
}

describe("a dump's failure survives being piped into a compressor", () => {
  it("passes the payload through and exits 0 when everything worked", () => {
    const { code, stdout } = run(safeDumpCommand("printf DUMPDATA", "gzip"));
    expect(code).toBe(0);
    // gzip's magic bytes — the payload really went through the compressor, and only
    // the payload: the status reports ride fd 3, not stdout.
    expect(stdout[0]).toBe(0x1f);
    expect(stdout[1]).toBe(0x8b);
  });

  it("reports the DUMP's exit code, not the compressor's success", () => {
    // The #633/#611 masking bug in one assertion. Before the fix this was exit 0
    // with a valid ~27-byte gzip stream: a backup that looked like a small database.
    const { code, stderr } = run(
      safeDumpCommand("sh -c 'printf partial; exit 4'", "gzip"),
    );
    expect(code).toBe(4);
    expect(stderr).toMatch(/dump command failed with status 4/);
  });

  it("fails when the compressor is not installed in the container", () => {
    // `zstd` absent from the image. The dump's own write often fits the pipe buffer
    // and succeeds, so this could only ever be caught on the compressor's side.
    const { code, stderr } = run(
      safeDumpCommand("printf DUMPDATA", "zstd").map((a) =>
        a.replace("zstd -c -3", "zstd_definitely_absent -c -3"),
      ),
    );
    expect(code).not.toBe(0);
    expect(stderr).toMatch(/compressor .* failed with status/);
  });

  it("uses no pipeline at all for an uncompressed dump", () => {
    // pg_dump -Fc / mongodump --gzip compress themselves; the simplest correct
    // thing is to leave the status alone rather than wrap it.
    const argv = safeDumpCommand("printf RAW", "none");
    expect(argv).toEqual(["sh", "-c", "printf RAW"]);
    const { code, stdout } = run(argv);
    expect(code).toBe(0);
    expect(stdout.toString()).toBe("RAW");
  });

  it("keeps a prelude's stdout OUT of the artifact", () => {
    // The prelude runs with fd 1 still pointing at the payload stream, so anything it
    // prints is prepended to the dump — and every backstop passes: exit 0, one
    // artifact, non-zero size. The result is a green run over a file that cannot be
    // decompressed, which is strictly worse than a failure. Measured before the fix:
    // the artifact began `PRELUDE_NOISE\n` and only then gzip's 1f 8b.
    const { code, stdout, stderr } = run(
      safeDumpCommand("printf DUMPDATA", "gzip", "echo PRELUDE_NOISE"),
    );
    expect(code).toBe(0);
    expect(stdout[0]).toBe(0x1f); // the payload starts AT the gzip magic
    expect(stdout[1]).toBe(0x8b);
    expect(stdout.toString("latin1")).not.toContain("PRELUDE_NOISE");
    // Not swallowed either — it lands where diagnostics belong.
    expect(stderr).toContain("PRELUDE_NOISE");
  });

  it("keeps a prelude's stdout out of an UNCOMPRESSED dump too", () => {
    // The no-codec branch takes a different code path and had the same hole.
    const { code, stdout } = run(
      safeDumpCommand("printf RAWDUMP", "none", "echo PRELUDE_NOISE"),
    );
    expect(code).toBe(0);
    expect(stdout.toString()).toBe("RAWDUMP");
  });

  it("keeps a prelude's exports in scope for both sides of the pipe", () => {
    // `VAR=x cmd1 | cmd2` sets the variable on cmd1 only, which is how PGPASSWORD
    // failed to reach pg_restore. `export` in a prelude is the fix, and it has to
    // survive the fd plumbing.
    const { code, stdout } = run(
      safeDumpCommand('printf "%s" "$PGPASSWORD"', "none", "export PGPASSWORD=s3cret"),
    );
    expect(code).toBe(0);
    expect(stdout.toString()).toBe("s3cret");
  });
});

describe("a restore that decompresses nothing does not report success", () => {
  it("round-trips the artifact into the loader", () => {
    const payload = (run(safeDumpCommand("printf HELLO", "gzip"))).stdout;
    const { code, stdout } = run(safeRestoreCommand("gzip", "cat"), payload);
    expect(code).toBe(0);
    expect(stdout.toString()).toBe("HELLO");
  });

  it("reports the LOADER's failure through the decompressor pipeline", () => {
    const payload = (run(safeDumpCommand("printf HELLO", "gzip"))).stdout;
    const { code, stderr } = run(safeRestoreCommand("gzip", "false"), payload);
    expect(code).not.toBe(0);
    expect(stderr).toMatch(/restore command failed/);
  });

  it("applies a right-hand redirect to the whole loader, `&&` included", () => {
    // The redis loader is `cat > file && chmod …`. Without grouping, the fd-4
    // redirect binds to `chmod` alone — a shape that silently works until it does
    // not, so it is pinned.
    const payload = (run(safeDumpCommand("printf HI", "gzip"))).stdout;
    const { code } = run(safeRestoreCommand("gzip", "cat > /dev/null && true"), payload);
    expect(code).toBe(0);
  });

  it("skips the pipeline entirely for an uncompressed artifact", () => {
    expect(safeRestoreCommand("none", "pg_restore -d x")).toEqual([
      "sh",
      "-c",
      "pg_restore -d x",
    ]);
  });
});

describe("the codec recorded at capture is the one restore uses", () => {
  it("defaults an unknown or missing value to zstd, never to none", () => {
    // Every artifact written before the codec was recorded was zstd-compressed. A
    // `none` default would feed a compressed file straight into pg_restore.
    expect(recordedCodec(undefined)).toBe("zstd");
    expect(recordedCodec(null)).toBe("zstd");
    expect(recordedCodec("brotli")).toBe("zstd");
    expect(recordedCodec("gzip")).toBe("gzip");
    expect(recordedCodec("none")).toBe("none");
  });

  it("pairs each codec with a matching suffix and decompressor", () => {
    expect(codecSuffix("zstd")).toBe(".zst");
    expect(codecSuffix("gzip")).toBe(".gz");
    expect(codecSuffix("none")).toBe("");
    expect(decompressor("zstd")).toBe("zstd -d -c");
    expect(decompressor("gzip")).toBe("gzip -d -c");
    expect(decompressor("none")).toBeNull();
  });
});

describe("keys are relative to the destination's own root", () => {
  const parts = { projectSlug: "openship", serviceName: "postgres", runId: "bkr_1" };

  it("does not carry a destination pathPrefix", () => {
    // The destination applies its own on every put/get/delete. Carrying it here too
    // stored each artifact one level deeper than the key the run recorded, so a
    // bucket listing at `objectKeyPrefix` returned nothing — not even manifest.json.
    expect(runPrefix(parts)).toBe("openship/openship/postgres/bkr_1");
    expect(manifestKey(parts)).toBe("openship/openship/postgres/bkr_1/manifest.json");
    expect(artifactKey(parts, "pg-dump.dump")).toBe(
      "openship/openship/postgres/bkr_1/pg-dump.dump",
    );
  });

  it("still refuses a traversal segment", () => {
    expect(() => artifactKey(parts, "../../../etc/shadow")).toThrow(/not allowed/);
    expect(() => artifactKey({ ...parts, projectSlug: ".." }, "a")).toThrow(/not allowed/);
  });
});
