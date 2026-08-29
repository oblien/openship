/**
 * Every WAY of backing something up, round-tripped against a real daemon — one
 * container, one destination, every payload shape an operator can configure.
 *
 * `backup-volume-roundtrip.e2e.test.ts` proves the default path (all of a service's
 * volumes, no container, local destination). It does not cover the shapes an operator
 * actually configures, and each of those is a distinct code path:
 *
 *   1. a SUBSET of volumes, chosen by the policy (`payloadConfig.sourceIds`) — the
 *      selection was implemented in the adapter and reachable only through the API, so
 *      nothing had ever exercised it end to end;
 *   2. a plain FOLDER — a bind mount, which skips volume namespacing entirely and whose
 *      source id is a host path rather than a volume name;
 *   3. a QUIESCED capture — `docker pause` around the copy, where the thing that can go
 *      wrong is not the archive but the container being left frozen;
 *   4. `custom_command` — the generic escape hatch, whose restore command is frozen into
 *      the artifact's metadata at capture time and is therefore unrecoverable if wrong;
 *   5. `path` — folders named by the operator, archived from inside their OWN container.
 *      The whole filesystem-payload axis, and the one with the most ways to be quietly
 *      wrong: one artifact per folder rather than one per run, a restore that MERGES
 *      where every other kind replaces, a codec that depends on what the operator's
 *      image happens to carry, and two refusals (missing folder, empty folder) that
 *      exist because a small clean archive of nothing passes every other check.
 *
 * Deliberately light: no database images, no multi-GB fixtures, and `compression: "gzip"`
 * on the volume cases. That last one is not only for speed — zstd is not in `alpine:3`, so
 * the default makes every helper `apk add` it over the network, which costs ~20s per helper
 * and needs egress. gzip is a busybox built-in, so these cases run offline and in seconds.
 * The zstd path is still covered by `backup-volume-roundtrip.e2e.test.ts`.
 *
 * The DB producers' commands are covered by unit tests that run their generated shell under
 * `dash` (`backup-dump-pipeline.test.ts`); what a real daemon adds is volumes, binds, the
 * freezer, exec, and bytes landing on a destination — which is what this file is for.
 *
 * Every case asserts the artifact EXISTS at the destination with the recorded size,
 * because "the run said succeeded" is exactly the claim #611 taught us not to take on
 * trust. The REFUSAL cases assert the inverse and one thing more — that a failed run
 * left no objects behind, since bytes belonging to a run that can never be restored can
 * only ever be billed.
 *
 * Skips without a reachable daemon, FAILS under RUN_DOCKER_E2E=1 (what CI sets).
 */

import { it, expect, beforeAll, afterAll } from "vitest";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { DockerRuntime, initPlatform, resetPlatform, scopedVolumeName } from "@repo/adapters";
import { env } from "../../src/config";
import type { RequestContext } from "../../src/lib/request-context";
import { resolvePlatformConfig } from "../../src/lib/controller-helpers";
import { backupE2EHarness } from "../helpers/backup-e2e";
import { describeDockerE2E, requireDocker } from "../helpers/docker-e2e";
import {
  seedOrg,
  seedProject,
  seedDeployment,
  setActive,
  seedService,
  seedServiceDeployment,
  seedBackupDestination,
  seedBackupPolicy,
} from "../helpers/seed";

const IMAGE = "alpine:3";
const DATA_SPEC = "data:/data";
const CACHE_SPEC = "cache:/cache";

const DATA_FILE = "keep-me.txt";
const DATA_BODY = "volume payload — selected by the policy 🎯";
const CACHE_BODY = "cache payload — deliberately NOT selected";
const FOLDER_FILE = "notes.txt";
const FOLDER_BODY = "a plain folder, bind-mounted, nothing clever about it";

describeDockerE2E("backup payload matrix — every way, round-tripped", () => {
  let runtime: DockerRuntime;
  let ctx: RequestContext;
  let organizationId = "";
  let projectId = "";
  let serviceId = "";
  let destinationId = "";
  let policyId = "";
  let destRoot = "";
  let dataVolume = "";
  let cacheVolume = "";
  /**
   * The bind source lives under $HOME, not /tmp.
   *
   * Docker Desktop / colima on macOS share the home directory with the VM but not
   * `/tmp` — measured: a `/tmp` bind mounts an EMPTY directory rather than failing, which
   * would make this test pass while proving nothing. Linux CI shares everything, so this
   * only matters for running it locally.
   */
  let folderPath = "";
  let containerId = "";

  /** Run a script with all three sources mounted, as fixture plumbing (not the SUT). */
  const inSources = async (script: string): Promise<string> => {
    const helper = await runtime.docker.createContainer({
      Image: IMAGE,
      Cmd: ["sh", "-c", script],
      HostConfig: {
        Binds: [`${dataVolume}:/data`, `${cacheVolume}:/cache`, `${folderPath}:/folder`],
        AutoRemove: false,
      },
      AttachStdout: true,
      AttachStderr: true,
      Tty: true,
    });
    try {
      const stream = await helper.attach({ stream: true, stdout: true, stderr: true });
      const chunks: Buffer[] = [];
      stream.on("data", (c: Buffer) => chunks.push(Buffer.from(c)));
      await helper.start();
      const exit = (await helper.wait()) as { StatusCode: number };
      const out = Buffer.concat(chunks).toString("utf8");
      if (exit.StatusCode !== 0) throw new Error(`fixture exited ${exit.StatusCode}: ${out}`);
      return out;
    } finally {
      await helper.remove({ force: true }).catch(() => {});
    }
  };

  const containerIds = async (): Promise<Set<string>> =>
    new Set((await runtime.docker.listContainers({ all: true })).map((c) => c.Id));

  /**
   * Capture, restore, and "are the bytes really there" all come from the shared harness
   * (`test/helpers/backup-e2e.ts`) rather than living here — `backup-db-roundtrip` drives
   * the same four moves, and two copies of an assertion is how one of them stops
   * asserting. The ids are read through a thunk because they are assigned in `beforeAll`.
   */
  const { attemptCapture, capture, restore, destObjects } = backupE2EHarness(() => ({
    ctx,
    organizationId,
    projectId,
    serviceId,
    policyId,
    destinationId,
    destRoot,
  }));

  beforeAll(async () => {
    await requireDocker();
    await initPlatform(resolvePlatformConfig());
    runtime = await DockerRuntime.create({ transport: "socket" });
    await runtime.pullImage(IMAGE);

    const org = await seedOrg();
    organizationId = org.organizationId;
    const slug = `bk-mtx-${randomBytes(4).toString("hex")}`;
    const project = await seedProject(organizationId, { slug, name: slug });
    projectId = project.id;

    const dep = await seedDeployment(project, {
      status: "ready",
      meta: { deployTarget: "local", runtimeMode: "docker" } as never,
    });
    await setActive(projectId, dep.id);

    dataVolume = scopedVolumeName(slug, "data");
    cacheVolume = scopedVolumeName(slug, "cache");
    await runtime.docker.createVolume({ Name: dataVolume });
    await runtime.docker.createVolume({ Name: cacheVolume });

    folderPath = await mkdtemp(join(homedir(), ".openship-e2e-folder-"));
    await writeFile(join(folderPath, FOLDER_FILE), FOLDER_BODY);

    const service = await seedService(projectId, {
      name: "app",
      image: IMAGE,
      volumes: [DATA_SPEC, CACHE_SPEC, `${folderPath}:/folder`],
      namespaceVolumes: true,
    });
    serviceId = service.id;

    // A RUNNING container, labelled the way a native deploy labels one so
    // `resolveLiveServiceState` matches it by identity. Three of the four cases need it:
    // quiesce freezes it, custom_command execs in it, and with a container present
    // `listSources` reads the LIVE mounts (ids are volume names / host paths) rather than
    // the DB-derived fallback ids.
    const container = await runtime.docker.createContainer({
      Image: IMAGE,
      Cmd: ["sleep", "600"],
      Labels: { "openship.project": projectId, "openship.service": "app" },
      HostConfig: {
        Binds: [`${dataVolume}:/data`, `${cacheVolume}:/cache`, `${folderPath}:/folder`],
        AutoRemove: false,
      },
    });
    await container.start();
    containerId = container.id;
    await seedServiceDeployment(dep.id, { id: serviceId, name: "app" }, { containerId });

    await inSources(
      `set -e; printf %s '${DATA_BODY}' > /data/${DATA_FILE}; ` +
        `printf %s '${CACHE_BODY}' > /cache/untouched.txt`,
    );

    await mkdir(env.BACKUP_LOCAL_ROOT, { recursive: true });
    destRoot = await mkdtemp(join(env.BACKUP_LOCAL_ROOT, "mtx-"));
    const destination = await seedBackupDestination(organizationId, {
      kind: "local",
      endpoint: destRoot,
    });
    destinationId = destination.id;
    const policy = await seedBackupPolicy(destinationId, {
      projectId,
      serviceId,
      sourceKind: "service",
      payloadKind: "volume",
      enabled: true,
    });
    policyId = policy.id;

    ctx = { userId: org.userId, organizationId } as unknown as RequestContext;
  }, 300_000);

  afterAll(async () => {
    if (containerId) {
      await runtime.docker.getContainer(containerId).remove({ force: true }).catch(() => {});
    }
    for (const v of [dataVolume, cacheVolume]) {
      if (v) await runtime.docker.getVolume(v).remove({ force: true }).catch(() => {});
    }
    if (folderPath) await rm(folderPath, { recursive: true, force: true }).catch(() => {});
    await rm(env.BACKUP_LOCAL_ROOT, { recursive: true, force: true }).catch(() => {});
    await runtime?.dispose?.().catch(() => {});
    resetPlatform();
  }, 120_000);

  it("backs up only the volumes the policy selected, and restores them", async () => {
    // `sourceIds` was honored by the producer and writable only through the API, so this is
    // the first thing to actually exercise it against a daemon. The negative half is the
    // point: a selection that quietly captured everything would look identical in the run
    // row, and only the untouched second volume proves otherwise.
    const before = await containerIds();
    const { runId, artifacts } = await capture("volume", {
      sourceIds: [dataVolume],
      compression: "gzip",
    });

    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].metadata.volumeSource).toBe(dataVolume);
    expect(artifacts[0].metadata.consistency).toBe("crash");

    // Destroy only the selected volume's contents, then put them back.
    await inSources("find /data -mindepth 1 -delete");
    expect((await inSources("find /data -mindepth 1 | wc -l")).trim()).toBe("0");

    await restore(runId);

    expect((await inSources(`cat /data/${DATA_FILE}`)).trim()).toBe(DATA_BODY);
    // And the volume the policy did NOT select was never in the archive, so restoring
    // could not have touched it.
    expect((await inSources("cat /cache/untouched.txt")).trim()).toBe(CACHE_BODY);

    expect([...(await containerIds())].filter((id) => !before.has(id))).toEqual([]);
  }, 900_000);

  it("backs up a plain folder (bind mount) and restores it", async () => {
    // A bind skips volume namespacing entirely and its source id is a HOST PATH, so it
    // exercises a different branch of listSources/matchBackupSource than a named volume.
    // The fixture reads and writes it with plain fs calls, because for a bind the API host
    // and the mount source are the same directory.
    const { runId, artifacts } = await capture("volume", {
      sourceIds: [folderPath],
      compression: "gzip",
    });

    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].metadata.volumeType).toBe("bind");

    await rm(join(folderPath, FOLDER_FILE));
    expect(await readdir(folderPath)).toEqual([]);

    await restore(runId);

    expect(await readdir(folderPath)).toEqual([FOLDER_FILE]);
    expect(await readFile(join(folderPath, FOLDER_FILE), "utf8")).toBe(FOLDER_BODY);
  }, 900_000);

  it("freezes the container for a consistent copy and leaves it running", async () => {
    // What can actually go wrong here is not the archive — it is the container being left
    // frozen, which is an outage caused by a backup. So the assertion is the container's
    // state afterwards, plus the label the artifact carries so an operator can tell which
    // kind of copy they have.
    const { artifacts } = await capture("volume", {
      sourceIds: [dataVolume],
      quiesce: true,
      compression: "gzip",
    });

    expect(artifacts[0].metadata.consistency).toBe("quiesced");

    const state = (await runtime.docker.getContainer(containerId).inspect()).State as {
      Running: boolean;
      Paused: boolean;
    };
    expect(state.Paused).toBe(false);
    expect(state.Running).toBe(true);
  }, 900_000);

  it("round-trips an arbitrary custom_command payload", async () => {
    // The generic escape hatch — anything an operator can express as a shell pipeline. Its
    // restoreCommand is frozen into the artifact's metadata at capture time, which is what
    // makes a wrong one permanently unrestorable, so a round trip is the only real check.
    const marker = `custom-${randomBytes(3).toString("hex")}`;
    const { runId, artifacts } = await capture("custom_command", {
      produceCommand: `printf %s '${marker}' | tee /data/custom.txt >/dev/null; cat /data/custom.txt`,
      restoreCommand: "cat > /data/custom.txt",
      artifactName: "custom.bin",
    });

    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].payloadKind).toBe("custom_command");
    expect(artifacts[0].metadata.restoreCommand).toBe("cat > /data/custom.txt");

    await inSources("rm -f /data/custom.txt");
    await restore(runId);

    expect((await inSources("cat /data/custom.txt")).trim()).toBe(marker);
  }, 900_000);

  // ─── path: folders and files, named by the operator ────────────────────────────
  //
  // The whole filesystem-payload axis had no end-to-end coverage. It is not a variant
  // of the volume path — it archives from INSIDE the operator's own container (so the
  // codec is whatever that image happens to carry), it produces one artifact PER named
  // folder, and its restore MERGES by default where a volume restore replaces. Every
  // one of those differences is a place a wrong answer looks like a green run.
  //
  // Each case builds its own fixture rather than sharing one, because the volume cases
  // above empty `/data` and a shared tree would make these pass or fail on test order.

  /** Lay down a small nested tree inside the service, and answer its manifest. */
  const seedTree = async (dir: string, marker: string) => {
    await inSources(
      `set -e; rm -rf ${dir}; mkdir -p ${dir}/assets; ` +
        `printf %s '${marker}-index' > ${dir}/index.html; ` +
        `printf %s '${marker}-css' > ${dir}/assets/app.css`,
    );
  };

  /** Every file under a directory in the service, sorted — the restore's real verdict. */
  const treeOf = async (dir: string): Promise<string[]> => {
    const out = await inSources(`cd ${dir} 2>/dev/null && find . -type f | sort || true`);
    return out
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("./"));
  };

  const readIn = async (file: string): Promise<string> =>
    (await inSources(`cat ${file}`)).trim();

  it("archives each named folder into its own artifact, and restores by MERGE", async () => {
    // Merge is the `path` default and the opposite of the volume default, so it is the
    // behaviour most likely to be wrong by inheritance. The positive half (the captured
    // tree comes back) would pass under either semantics — what separates them is the
    // file created AFTER the capture, which a replace would delete. An operator archiving
    // /var/www while the app also writes uploads there is exactly that case.
    await seedTree("/data/site", "merge");
    const { runId, artifacts } = await capture("path", {
      paths: ["/data/site"],
      compression: "gzip",
    });

    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].payloadKind).toBe("path");
    // The target is recorded on the ARTIFACT, not read back off the policy — a policy is
    // editable and soft-deletable, so an artifact that cannot name its own destination
    // stops being a restore point the moment somebody edits the schedule.
    expect(artifacts[0].metadata.path).toBe("/data/site");
    expect(artifacts[0].metadata.consistency).toBe("crash");

    await inSources("rm -f /data/site/index.html; printf %s 'local' > /data/site/local-only.txt");
    await restore(runId);

    expect(await readIn("/data/site/index.html")).toBe("merge-index");
    expect(await readIn("/data/site/assets/app.css")).toBe("merge-css");
    // The merge assertion. Deleting this file would be data loss on a restore nobody
    // asked to replace anything.
    expect(await readIn("/data/site/local-only.txt")).toBe("local");
  }, 900_000);

  it("replaces the folder when the policy asks for it, and only then", async () => {
    // `clearPath` is the destructive half, so it is asserted for what it REMOVES as well
    // as what it writes. It also travels a different code path: the restore prelude has
    // to prove its decompressor exists, mkdir the target, and confine the delete to one
    // directory's immediate children — before tar runs.
    await seedTree("/data/site", "replace");
    const { runId } = await capture("path", {
      paths: ["/data/site"],
      clearPath: true,
      compression: "gzip",
    });

    await inSources("printf %s 'stray' > /data/site/stray.txt; rm -rf /data/site/assets");
    await restore(runId);

    expect(await treeOf("/data/site")).toEqual(["./assets/app.css", "./index.html"]);
    expect(await readIn("/data/site/index.html")).toBe("replace-index");
  }, 900_000);

  it("recreates a folder the service no longer has", async () => {
    // The rebuilt-container case, and the reason the restore prelude runs `mkdir -p`
    // instead of refusing: after a container is recreated from its image the folder is
    // simply absent, and that is precisely when the operator reaches for the backup.
    await seedTree("/data/site", "recreate");
    const { runId } = await capture("path", { paths: ["/data/site"], compression: "gzip" });

    await inSources("rm -rf /data/site");
    expect(await treeOf("/data/site")).toEqual([]);

    await restore(runId);
    expect(await readIn("/data/site/index.html")).toBe("recreate-index");
  }, 900_000);

  it("gives every named folder its own independently restorable artifact", async () => {
    // One artifact per path, not one archive of all of them. It matters for restore
    // granularity — and for the `clearTarget` decision, which the orchestrator makes per
    // ARTIFACT because a single run can hold both a volume and a path artifact and they
    // do not want the same answer.
    await seedTree("/data/site", "multi-site");
    await seedTree("/data/conf", "multi-conf");
    const { runId, artifacts } = await capture("path", {
      paths: ["/data/site", "/data/conf"],
      compression: "gzip",
    });

    expect(artifacts).toHaveLength(2);
    expect(artifacts.map((a) => a.metadata.path).sort()).toEqual(["/data/conf", "/data/site"]);
    // Distinct keys, or one would have overwritten the other at the destination and the
    // run would still have looked perfect.
    expect(new Set(artifacts.map((a) => a.key)).size).toBe(2);

    await inSources("rm -rf /data/site /data/conf");
    await restore(runId);

    expect(await readIn("/data/site/index.html")).toBe("multi-site-index");
    expect(await readIn("/data/conf/index.html")).toBe("multi-conf-index");
  }, 900_000);

  it("honors the compression the policy chose, and records what it really wrote", async () => {
    // The declared `compression` key was accepted by the API and IGNORED by this
    // producer, so an operator's choice was decorative and the artifact carried whatever
    // the probe picked. That is the shape of the worst failure in this module: a recorded
    // codec that does not match the bytes restores through the wrong decompressor
    // forever. So this asserts the bytes themselves, not just the metadata.
    await seedTree("/data/site", "codec");

    const gz = await capture("path", { paths: ["/data/site"], compression: "gzip" });
    expect(gz.artifacts[0].metadata.compression).toBe("gzip");
    expect(gz.artifacts[0].key.endsWith(".tar.gz")).toBe(true);
    const gzHead = await readFile(join(destRoot, gz.artifacts[0].key));
    expect([gzHead[0], gzHead[1]]).toEqual([0x1f, 0x8b]); // gzip magic

    const raw = await capture("path", { paths: ["/data/site"], compression: "none" });
    expect(raw.artifacts[0].metadata.compression).toBe("none");
    expect(raw.artifacts[0].key.endsWith(".tar")).toBe(true);
    const rawHead = await readFile(join(destRoot, raw.artifacts[0].key));
    expect([rawHead[0], rawHead[1]]).not.toEqual([0x1f, 0x8b]);
    // A tar header carries the first entry's name at offset 0 — "./" for `-C dir .`.
    expect(rawHead.subarray(0, 2).toString("ascii")).toBe("./");

    // And the uncompressed artifact still round-trips, which is what proves the recorded
    // codec and the real bytes agree in BOTH directions.
    await inSources("rm -rf /data/site");
    await restore(raw.runId);
    expect(await readIn("/data/site/index.html")).toBe("codec-index");
  }, 900_000);

  it("fails loudly rather than silently downgrading a codec the image lacks", async () => {
    // `zstd` is not in `alpine:3`. An explicit choice the container cannot honor has to
    // fail the capture: downgrading would write an artifact whose compression nobody
    // chose, and — worse — the pipeline's exit status used to be the COMPRESSOR's, so a
    // missing tool could report success over a truncated archive.
    await seedTree("/data/site", "nozstd");
    const row = await attemptCapture("path", { paths: ["/data/site"], compression: "zstd" });

    expect(row.status).toBe("failed");
    // Not just "no restore point": no LIST of one either. The artifact list is written
    // incrementally as each upload lands, so a refusal after the first byte moved used
    // to leave entries naming objects the failure path had already reclaimed — and the
    // restore wizard renders that length to the operator as "N artifacts".
    expect(row.artifacts ?? []).toHaveLength(0);
    expect(row.bytesTransferred ?? 0).toBe(0);
  }, 900_000);

  it("refuses a folder that does not exist, and leaves nothing behind", async () => {
    // The silent-success class this module is built against: `tar` on a missing directory
    // could exit non-zero behind a compressor that exits 0, and a run that recorded a
    // tiny artifact would look like a backup forever. The guard runs BEFORE tar, in the
    // container, and the run has to end `failed` with no artifact and no orphaned bytes.
    const before = await destObjects();
    const row = await attemptCapture("path", {
      paths: ["/data/definitely-not-here"],
      compression: "gzip",
    });

    expect(row.status).toBe("failed");
    expect(row.artifacts ?? []).toHaveLength(0);
    expect(row.errorMessage ?? "").toContain("/data/definitely-not-here");
    expect(row.bytesTransferred ?? 0).toBe(0);
    // A failed run is not a restore point, so its bytes can only ever be billed. The
    // orchestrator reclaims them; this is the assertion that it really does.
    expect(await destObjects()).toBe(before);
  }, 900_000);

  it("refuses an EMPTY folder rather than recording an empty archive as a backup", async () => {
    // The subtler half, and the one that would otherwise pass every check: an empty
    // directory tars cleanly, uploads cleanly, and hashes cleanly. A policy pointed one
    // level off a volume mount — or at an app that moved its data directory — produces
    // exactly this, and it is indistinguishable from a real backup in every UI.
    await inSources("rm -rf /data/hollow; mkdir -p /data/hollow");
    const before = await destObjects();
    const row = await attemptCapture("path", { paths: ["/data/hollow"], compression: "gzip" });

    expect(row.status).toBe("failed");
    expect(row.artifacts ?? []).toHaveLength(0);
    expect(row.errorMessage ?? "").toContain("empty");
    expect(row.bytesTransferred ?? 0).toBe(0);
    expect(await destObjects()).toBe(before);
  }, 900_000);
});
