/**
 * The `path` producer — folders an operator names, not mounts Docker reported.
 *
 * Two halves, because either alone is a false pass: that the generated script CARRIES
 * each guard, and that the guard does what it claims when a real shell runs it. The
 * shell half runs the SCRIPT THE PRODUCER GENERATED, extracted from the captured argv,
 * rather than a hand-copied approximation of it — a reconstruction can only ever prove
 * that the test file agrees with itself.
 *
 * The guards under test are the ones this module's history says are load-bearing:
 *
 *   - **exit 66 / 67** — a missing or empty source fails the capture. #611 is a policy
 *     that reported green having captured nothing, and an empty directory is the shape
 *     that produces: a valid ~130-byte tar that lists as a restore point forever.
 *   - **exit 90** — the decompressor is proven to exist BEFORE anything is deleted.
 *     Without it a missing `zstd` gave `rm -rf` followed by `tar -x` reading EOF and
 *     exiting 0: target emptied, nothing extracted, green restore. That case is
 *     asserted here by running the real script with a PATH that genuinely has no
 *     `zstd`, and then asserting the file is STILL THERE.
 *
 * Paths are made under `/tmp` rather than `os.tmpdir()` on purpose: on macOS the latter
 * is `/var/folders/…`, and `/var` is a system root that `validateClearPath` refuses —
 * correctly, but it would make the clear tests untestable for the wrong reason.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { PathArchiveProducer } from "../src/backup/producers/path";
import type {
  Artifact,
  ArtifactRef,
  BackupExecutor,
  ExecExitInfo,
  ServiceHandle,
} from "../src/backup/types";

const service = (over: Partial<ServiceHandle> = {}): ServiceHandle => ({
  id: "svc_1",
  projectId: "prj_1",
  name: "web",
  image: "nginx:1.27",
  env: {},
  volumes: [],
  containerId: "c0ffee123456",
  projectSlug: "shop",
  namespaceVolumes: false,
  ...over,
});

/** Captures every argv the producer asks the executor to run. */
function recorder(codec: "zstd" | "gzip" | "none", exit: ExecExitInfo = { code: 0, stderr: "" }) {
  const cmds: string[][] = [];
  const executor = {
    execStream: async (_s: ServiceHandle, cmd: string[]) => {
      cmds.push(cmd);
      // The codec probe is the one call whose OUTPUT the producer reads.
      const isProbe = cmd.join(" ").includes("command -v zstd");
      return {
        // Buffers, not strings: `detectDumpCodec` concats its chunks, and a probe that
        // yields strings makes `Buffer.concat` throw — which the probe swallows into
        // "none" by contract, silently making every codec assertion below vacuous.
        stdout: Readable.from(isProbe ? [Buffer.from(`${codec}\n`)] : []),
        awaitExit: Promise.resolve(exit),
      };
    },
    pipeIntoCommand: async (_s: ServiceHandle, cmd: string[]) => {
      cmds.push(cmd);
      return exit;
    },
  } as unknown as BackupExecutor;
  return { cmds, executor };
}

/** Drain the generator, returning the artifacts it yielded. */
async function capture(
  paths: string[],
  codec: "zstd" | "gzip" | "none" = "zstd",
  extra: Record<string, unknown> = {},
) {
  const { cmds, executor } = recorder(codec);
  const out: Artifact[] = [];
  for await (const a of PathArchiveProducer.produce(service(), executor, {
    paths,
    ...extra,
  } as never)) {
    out.push(a);
  }
  return { artifacts: out, cmds };
}

const artifactRef = (over: Partial<ArtifactRef> = {}): ArtifactRef => ({
  key: "runs/r1/path-data.tar.zst",
  metadata: { path: "/data/app", compression: "zstd" },
  payloadKind: "path",
  sha256: "0".repeat(64),
  sizeBytes: 4096,
  open: async () => Readable.from([]),
  ...over,
});

/** The `sh -c` script from a captured argv. */
const scriptOf = (cmd: string[]) => cmd[2] ?? "";

// ── capture: what the policy names is what gets archived ─────────────────────

describe("a path policy archives each named folder as its own artifact", () => {
  it("yields one artifact per path, named after it", async () => {
    const { artifacts } = await capture(["/data/app", "/srv/uploads"]);
    expect(artifacts.map((a) => a.name)).toEqual([
      "path-data_app.tar.zst",
      "path-srv_uploads.tar.zst",
    ]);
    // One artifact per path is the point: three folders give three independently
    // restorable units, not one all-or-nothing archive.
    expect(artifacts).toHaveLength(2);
  });

  it("records the restore target on the artifact, not on the policy", async () => {
    // A policy is editable and soft-deletable. An artifact that reads its target back
    // off the policy stops being a restore point the moment somebody edits the
    // schedule.
    const { artifacts } = await capture(["/data/app"]);
    expect(artifacts[0]!.metadata).toMatchObject({
      path: "/data/app",
      compression: "zstd",
      consistency: "crash",
    });
  });

  it("says crash-consistent even when nothing asked about consistency", async () => {
    // `quiesce` is not offered (a paused container cannot exec `tar`), so the artifact
    // has to state what it is rather than leave an operator to assume a snapshot.
    const { artifacts } = await capture(["/data/app"], "none");
    expect(artifacts[0]!.metadata.consistency).toBe("crash");
    expect(artifacts[0]!.name).toBe("path-data_app.tar");
  });

  it("probes the codec once for the whole run, not once per path", async () => {
    const { cmds } = await capture(["/a/one", "/a/two", "/a/three"]);
    const probes = cmds.filter((c) => c.join(" ").includes("command -v zstd"));
    expect(probes).toHaveLength(1);
  });

  it("honors an explicit compression choice instead of probing", async () => {
    // `compression` is a declared config key for this kind, so the dialog's control has
    // to actually decide something. The probe would have answered zstd here.
    const { cmds, artifacts } = await capture(["/data/app"], "zstd", { compression: "gzip" });
    expect(artifacts[0]!.name).toBe("path-data_app.tar.gz");
    expect(artifacts[0]!.metadata.compression).toBe("gzip");
    // …and no probe was needed at all.
    expect(cmds.some((c) => c.join(" ").includes("command -v zstd"))).toBe(false);
  });

  it("probes only when the policy did not choose", async () => {
    const { cmds } = await capture(["/data/app"], "gzip");
    expect(cmds.some((c) => c.join(" ").includes("command -v zstd"))).toBe(true);
  });

  it("collapses duplicate and differently-spelled paths", async () => {
    // `/data/app/` and `/data//app` are the same directory; archiving it twice would
    // bill the destination twice and give the operator two identical restore points.
    const { artifacts } = await capture(["/data/app", "/data/app/", "/data//app"]);
    expect(artifacts).toHaveLength(1);
  });

  it("refuses a policy that archives folders but names none", async () => {
    await expect(capture([])).rejects.toThrow(/archives files and folders but names none/);
  });

  it("refuses a relative path and a traversal, before any shell sees it", async () => {
    // Every one of these strings is interpolated into a shell command, so they are
    // re-validated here and not only at save time: a row can predate the validation,
    // arrive from an import, or be written by a migration.
    await expect(capture(["data/app"])).rejects.toThrow(/absolute/i);
    await expect(capture(["/data/../../etc"])).rejects.toThrow(/\.\./);
  });
});

describe("the capture script gates a missing or empty source", () => {
  it("carries both gates, for every codec", async () => {
    // `none` skips the pipeline entirely and takes a different branch of
    // safeDumpCommand, so a gate added only to the compressed path would leave an
    // uncompressed policy silently backing up nothing.
    for (const codec of ["none", "gzip", "zstd"] as const) {
      const { cmds } = await capture(["/data/app"], codec);
      const script = scriptOf(cmds.at(-1)!);
      expect(script, codec).toContain("exit 66");
      expect(script, codec).toContain("exit 67");
      // The path and the service are named, because "something was empty" is not
      // actionable from a notification.
      expect(script, codec).toContain("/data/app");
      expect(script, codec).toContain("web");
    }
  });

  it("archives contents, not the directory itself", async () => {
    // `-C <dir> .` is what makes an artifact captured from /data/app restorable after
    // the app moved to /srv/app.
    const { cmds } = await capture(["/data/app"], "none");
    expect(scriptOf(cmds.at(-1)!)).toContain("tar -c -C '/data/app' .");
  });

  it("passes excludes through as tar excludes, quoted", async () => {
    const { cmds } = await capture(["/data/app"], "none", { exclude: ["./cache", "*.sock"] });
    const script = scriptOf(cmds.at(-1)!);
    expect(script).toContain("--exclude='./cache'");
    expect(script).toContain("--exclude='*.sock'");
  });
});

// ── capture: the gate, under a real shell ────────────────────────────────────

/** Run a generated capture script with `path` pointed at a real directory. */
async function runCapture(dir: string) {
  const { cmds } = await capture([dir], "none");
  const script = scriptOf(cmds.at(-1)!);
  expect(script, "generated script should name the directory").toContain(dir);
  return spawnSync("/bin/sh", ["-c", script], { maxBuffer: 8 * 1024 * 1024 });
}

describe("the generated gate behaves as claimed under /bin/sh", () => {
  it("exits 66 and names the path when the folder is absent", async () => {
    const missing = "/tmp/openship-path-definitely-absent-4f19c";
    expect(existsSync(missing)).toBe(false);
    const run = await runCapture(missing);
    expect(run.status).toBe(66);
    expect(run.stderr.toString()).toContain("does not exist inside service web");
  });

  it("exits 67 on a folder that exists and is empty", async () => {
    const empty = mkdtempSync("/tmp/openship-path-empty-");
    const run = await runCapture(empty);
    expect(run.status).toBe(67);
    // The diagnosis, not just the refusal: an existing-but-empty directory almost
    // always means the data is somewhere else.
    expect(run.stderr.toString()).toMatch(/exists .* but is empty/);
  });

  it("passes a folder whose only content is a dotfile", async () => {
    // `find -mindepth 1` counts hidden entries; `ls` would not, and a tree whose only
    // content is `.env` or `.git` is exactly the case an `ls`-based gate would have
    // called empty and refused.
    const dotOnly = mkdtempSync("/tmp/openship-path-dot-");
    writeFileSync(join(dotOnly, ".env"), "SECRET=1");
    const run = await runCapture(dotOnly);
    expect(run.status, run.stderr.toString()).toBe(0);
  });

  it("passes a populated folder and the archive holds its contents", async () => {
    const full = mkdtempSync("/tmp/openship-path-full-");
    mkdirSync(join(full, "public"));
    writeFileSync(join(full, "public", "index.html"), "<h1>hi</h1>");
    const run = await runCapture(full);
    expect(run.status, run.stderr.toString()).toBe(0);
    // A byte count proves nothing — tar's 10240-byte blocking makes a small file the
    // same size as nothing at all, which is why the orchestrator's `sizeBytes === 0`
    // check could never catch an empty capture. Assert the CONTENT.
    const listed = spawnSync("/usr/bin/tar", ["-t"], {
      input: run.stdout,
      maxBuffer: 8 * 1024 * 1024,
    });
    expect(listed.stdout.toString()).toContain("public/index.html");
  });
});

// ── restore ─────────────────────────────────────────────────────────────────

describe("restore reads its target from the artifact and validates it again", () => {
  it("refuses an artifact with no recorded path", async () => {
    const { executor } = recorder("zstd");
    await expect(
      PathArchiveProducer.restore(
        service(),
        executor,
        artifactRef({ metadata: { compression: "zstd" } }),
        {} as never,
      ),
    ).rejects.toThrow(/metadata.path missing/);
  });

  it("refuses an artifact whose recorded path is unusable", async () => {
    // Stored data is not a trust boundary: this string is about to be interpolated
    // into a shell command.
    const { executor } = recorder("zstd");
    await expect(
      PathArchiveProducer.restore(
        service(),
        executor,
        artifactRef({ metadata: { path: "/data/../../etc", compression: "none" } }),
        {} as never,
      ),
    ).rejects.toThrow(/records an unusable path/);
  });

  it("merges by default — no clear unless the operator asked", async () => {
    // A volume is a single-purpose store, so clearing is its default. A path can be a
    // directory the service uses for other things too, so the default here is to
    // extract OVER what is present.
    const { cmds, executor } = recorder("none");
    await PathArchiveProducer.restore(service(), executor, artifactRef(), {} as never);
    const script = scriptOf(cmds.at(-1)!);
    expect(script).toContain("mkdir -p '/data/app'");
    expect(script).not.toContain("rm -rf");
    expect(script).toContain("tar -x -C '/data/app'");
  });

  it("clears only when asked, and proves the decompressor first", async () => {
    const { cmds, executor } = recorder("zstd");
    await PathArchiveProducer.restore(service(), executor, artifactRef(), {
      clearTarget: true,
    } as never);
    const script = scriptOf(cmds.at(-1)!);
    // Ordering is the whole guard: prove, then create, then destroy.
    expect(script.indexOf("command -v zstd")).toBeLessThan(script.indexOf("mkdir -p"));
    expect(script.indexOf("mkdir -p")).toBeLessThan(script.indexOf("rm -rf"));
    expect(script).toContain("exit 90");
    expect(script).toContain("exit 91");
  });

  it("refuses to clear a system root, whatever the artifact says", async () => {
    const { executor } = recorder("zstd");
    await expect(
      PathArchiveProducer.restore(
        service(),
        executor,
        artifactRef({ metadata: { path: "/etc/nginx", compression: "zstd" } }),
        { clearTarget: true } as never,
      ),
    ).rejects.toThrow(/holds the operating system/);
    // …and the same path restores fine WITHOUT clearing, which is the useful case:
    // extracting a config tree back over itself.
    const ok = recorder("zstd");
    await expect(
      PathArchiveProducer.restore(
        service(),
        ok.executor,
        artifactRef({ metadata: { path: "/etc/nginx", compression: "zstd" } }),
        {} as never,
      ),
    ).resolves.toBeUndefined();
  });

  it("surfaces a non-zero restore with the path and the stderr", async () => {
    const { executor } = recorder("none", { code: 2, stderr: "tar: unexpected EOF" });
    await expect(
      PathArchiveProducer.restore(service(), executor, artifactRef(), {} as never),
    ).rejects.toThrow(/Restoring \/data\/app into service "web" failed \(exit 2\).*unexpected EOF/s);
  });
});

/** Run a generated restore script against a real directory, feeding it a real tar. */
async function runRestore(
  dir: string,
  tarBytes: Buffer,
  opts: { clear?: boolean; codec?: "zstd" | "none"; path?: string } = {},
) {
  const codec = opts.codec ?? "none";
  const { cmds, executor } = recorder(codec);
  await PathArchiveProducer.restore(
    service(),
    executor,
    artifactRef({ metadata: { path: dir, compression: codec } }),
    { clearTarget: opts.clear === true } as never,
  );
  const script = scriptOf(cmds.at(-1)!);
  return { script, run: (env?: NodeJS.ProcessEnv) =>
    spawnSync("/bin/sh", ["-c", script], { input: tarBytes, env: env ?? process.env }) };
}

/** A tar whose single member is `restored.txt`. */
function tarWithRestoredFile(): Buffer {
  const src = mkdtempSync("/tmp/openship-path-src-");
  writeFileSync(join(src, "restored.txt"), "from the backup");
  const made = spawnSync("/usr/bin/tar", ["-c", "-C", src, "."], { maxBuffer: 8 * 1024 * 1024 });
  expect(made.status, made.stderr?.toString()).toBe(0);
  return made.stdout;
}

describe("the generated restore script behaves as claimed under /bin/sh", () => {
  it("creates the target when the container no longer has it", async () => {
    // The ordinary case for a rebuilt container, and the one thing that makes a path
    // artifact useful after the service was recreated from its image.
    const parent = mkdtempSync("/tmp/openship-path-parent-");
    const target = join(parent, "gone");
    const { run } = await runRestore(target, tarWithRestoredFile());
    const out = run();
    expect(out.status, out.stderr.toString()).toBe(0);
    expect(readFileSync(join(target, "restored.txt"), "utf8")).toBe("from the backup");
  });

  it("merges: files the artifact never had survive", async () => {
    const target = mkdtempSync("/tmp/openship-path-merge-");
    writeFileSync(join(target, "kept.txt"), "operator's own file");
    const { run } = await runRestore(target, tarWithRestoredFile());
    const out = run();
    expect(out.status, out.stderr.toString()).toBe(0);
    expect(existsSync(join(target, "kept.txt"))).toBe(true);
    expect(existsSync(join(target, "restored.txt"))).toBe(true);
  });

  it("clears: everything present goes, including dotfiles and subtrees", async () => {
    // `rm -rf dir/*` would leave `.hidden` behind and silently produce a hybrid of two
    // points in time. `find -mindepth 1 -maxdepth 1` does not.
    const target = mkdtempSync("/tmp/openship-path-clear-");
    writeFileSync(join(target, "stale.txt"), "old");
    writeFileSync(join(target, ".hidden"), "old");
    mkdirSync(join(target, "sub"));
    writeFileSync(join(target, "sub", "deep.txt"), "old");
    const { run } = await runRestore(target, tarWithRestoredFile(), { clear: true });
    const out = run();
    expect(out.status, out.stderr.toString()).toBe(0);
    expect(existsSync(join(target, "stale.txt"))).toBe(false);
    expect(existsSync(join(target, ".hidden"))).toBe(false);
    expect(existsSync(join(target, "sub"))).toBe(false);
    expect(existsSync(join(target, "restored.txt"))).toBe(true);
  });

  it("confines the clear to the target: a sibling directory is untouched", async () => {
    const parent = mkdtempSync("/tmp/openship-path-confine-");
    const target = join(parent, "target");
    const sibling = join(parent, "sibling");
    mkdirSync(target);
    mkdirSync(sibling);
    writeFileSync(join(target, "stale.txt"), "old");
    writeFileSync(join(sibling, "not-mine.txt"), "someone else's data");
    const { run } = await runRestore(target, tarWithRestoredFile(), { clear: true });
    const out = run();
    expect(out.status, out.stderr.toString()).toBe(0);
    expect(existsSync(join(sibling, "not-mine.txt"))).toBe(true);
    expect(existsSync(join(target, "stale.txt"))).toBe(false);
  });

  it("exits 90 WITHOUT deleting anything when the decompressor is absent", async () => {
    // The whole reason the guard exists. Before it: `rm -rf` ran, `tar -x` read EOF
    // from the missing `zstd`, and the restore exited 0 having emptied the target.
    // Proven against a PATH that really has no zstd, and asserted on the DATA.
    const target = mkdtempSync("/tmp/openship-path-nozstd-");
    writeFileSync(join(target, "precious.txt"), "the only copy");
    const bin = mkdtempSync("/tmp/openship-path-bin-");
    for (const tool of ["mkdir", "find", "rm", "tar", "sh", "cat"]) {
      const found = spawnSync("/bin/sh", ["-c", `command -v ${tool}`]).stdout.toString().trim();
      if (found) spawnSync("/bin/ln", ["-s", found, join(bin, tool)]);
    }
    const { run } = await runRestore(target, tarWithRestoredFile(), {
      clear: true,
      codec: "zstd",
    });
    const out = run({ PATH: bin });
    expect(out.status).toBe(90);
    expect(out.stderr.toString()).toContain("your data is untouched");
    expect(readFileSync(join(target, "precious.txt"), "utf8")).toBe("the only copy");
  });
});
