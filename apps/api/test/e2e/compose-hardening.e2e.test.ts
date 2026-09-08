/**
 * The five hardening controls against a REAL Docker daemon (#749).
 *
 * The one test in this feature that could not be faked. Everything else asserts
 * what openship SENDS; this asserts what the daemon actually BUILT, and then what
 * the container can and cannot do from the inside. A mock cannot tell a container
 * that is confined from one whose create payload merely mentioned confinement,
 * and telling those apart is the entire point of the issue: the failure being
 * fixed is a deploy that reports success while running something weaker than the
 * compose file described.
 *
 * Three things are proved, in the one place they can be:
 *
 *   1. THE SHAPE. A container deployed through the product's own
 *      `deployServiceWorkload` inspects as the exact Engine fields the compose
 *      file asked for: Config.User, HostConfig.ReadonlyRootfs / CapDrop /
 *      SecurityOpt / Tmpfs.
 *
 *   2. THE EFFECT. The shape is not the same claim as the confinement. The
 *      container is asked, from the inside, to write to its root filesystem, to
 *      write to its tmpfs, and to report its uid, its NoNewPrivs bit and its
 *      effective capability set. A container can carry `CapDrop: ["ALL"]` in an
 *      inspect and still have been started before the field reached the daemon.
 *
 *   3. THE READBACK. `inspectContainer` reports that same confinement back in the
 *      stored `advanced` shape, so adoption of a running container is reading the
 *      truth. The two directions share one authority module precisely so they
 *      cannot drift, and this is where that is checked against a real container
 *      rather than against the module's own output.
 *
 * The whole set is deployed as ONE service, deliberately: OWASP recommends these
 * five COMBINED, and the interesting failures are interactions (a read-only root
 * with no tmpfs cannot start most images; a dropped ALL with a numeric user
 * cannot chown). Five separate containers would each pass while the combination
 * nobody tested is the one an operator actually writes.
 *
 * Gated by `requireDocker()` (test/helpers/docker-e2e.ts): CI runs this with
 * RUN_DOCKER_E2E=1, where an unreachable daemon FAILS instead of skipping.
 */

import { afterAll, beforeAll, expect, it } from "vitest";
import { DockerRuntime } from "@repo/adapters";
import type { MultiServiceGroupHandle } from "@repo/adapters";
import { describeDockerE2E, requireDocker } from "../helpers/docker-e2e";

const IMAGE = "busybox:latest";
const SLUG = `e2e-hardening-${process.pid}`;
const SERVICE = "app";
const CONTAINER = `openship-${SLUG}-${SERVICE}`;

/** Exactly the OWASP set, in the shape the compose parser stores. */
const HARDENING = {
  user: "1000:1000",
  readOnly: true,
  capDrop: ["ALL"],
  securityOpt: ["no-new-privileges:true"],
  tmpfs: ["/run:size=64m,mode=1777"],
} as const;

/**
 * One shell that reports every confinement from INSIDE the container, so a single
 * container's logs answer all of question 2. Each line is prefixed so the
 * assertions cannot pass on an incidental substring.
 */
const PROBE = [
  "echo tmpfs-write=$(echo ok > /run/probe 2>/dev/null && cat /run/probe || echo FAILED)",
  "touch /rootfs-probe 2>/dev/null && echo rootfs=WRITABLE || echo rootfs=readonly",
  "echo uid=$(id -u):$(id -g)",
  "echo $(grep ^NoNewPrivs /proc/self/status | tr -d '\\t ')",
  "echo $(grep ^CapEff /proc/self/status | tr -d '\\t ')",
  "sleep 30",
].join("; ");

describeDockerE2E("compose hardening against a real Docker daemon", () => {
  let runtime: DockerRuntime;
  let group: MultiServiceGroupHandle;
  let containerId: string;

  beforeAll(async () => {
    await requireDocker();
    runtime = await DockerRuntime.create({ transport: "socket" });
    await runtime.pullImage(IMAGE);

    group = await runtime.ensureServiceGroup({
      deploymentId: "dep-hardening",
      projectId: "proj-hardening",
      slug: SLUG,
    });

    const result = await runtime.deployServiceWorkload(group, {
      deploymentId: "dep-hardening",
      projectId: "proj-hardening",
      slug: SLUG,
      serviceName: SERVICE,
      image: IMAGE,
      ports: [],
      environment: {},
      volumes: [],
      namespaceVolumes: true,
      commandArgv: ["sh", "-c", PROBE],
      advanced: { ...HARDENING },
    });
    containerId = result.containerId;

    // The probe runs and exits before `sleep`, so give it a moment to produce
    // its lines. The container stays up for the inspect assertions below.
    await new Promise((r) => setTimeout(r, 2_000));
  }, 180_000);

  afterAll(async () => {
    await runtime?.destroy(containerId).catch(() => {});
    await runtime?.dispose().catch(() => {});
  });

  it("builds the container with the exact Engine fields the compose file asked for", async () => {
    // Raw dockerode, used only to LOOK at what the product did.
    const data = await runtime.docker.getContainer(containerId).inspect();
    expect(data.Config.User).toBe("1000:1000");
    expect(data.HostConfig.ReadonlyRootfs).toBe(true);
    expect(data.HostConfig.CapDrop).toEqual(["ALL"]);
    expect(data.HostConfig.SecurityOpt).toEqual(["no-new-privileges:true"]);
    expect(data.HostConfig.Tmpfs).toEqual({ "/run": "size=64m,mode=1777" });
  });

  it("actually confines the running container, not just its create payload", async () => {
    const logs = await readLogs(runtime, containerId);

    // tmpfs: writable, in memory, inside an otherwise read-only root. This pair is
    // the reason OWASP names them together, and the reason the feature is one PR.
    expect(logs).toContain("tmpfs-write=ok");
    expect(logs).toContain("rootfs=readonly");
    // user: the image's own default is root; the file said otherwise.
    expect(logs).toContain("uid=1000:1000");
    // security_opt: no-new-privileges is a bit on the process, not a label.
    expect(logs).toContain("NoNewPrivs:1");
    // cap_drop ALL: an EMPTY effective set. Any nonzero value here means some
    // capability survived, which is the silent-downgrade shape exactly.
    expect(logs).toContain("CapEff:0000000000000000");
  });

  it("reads the same confinement back, in the shape adoption stores", async () => {
    const detail = await runtime.inspectContainer(containerId);
    expect(detail?.hardening).toEqual({
      user: "1000:1000",
      readOnly: true,
      capDrop: ["ALL"],
      securityOpt: ["no-new-privileges:true"],
      tmpfs: ["/run:size=64m,mode=1777"],
    });
  });
});

/** Both streams of the container's output, demuxed, as one string. */
async function readLogs(runtime: DockerRuntime, containerId: string): Promise<string> {
  const buf = (await runtime.docker.getContainer(containerId).logs({
    stdout: true,
    stderr: true,
  })) as unknown as Buffer;
  // Docker frames multiplexed logs with an 8-byte header per chunk; the payload
  // is plain text, so stripping non-printables is enough to assert against.
  return buf.toString("utf8").replace(/[^\x20-\x7E\n]/g, "");
}
