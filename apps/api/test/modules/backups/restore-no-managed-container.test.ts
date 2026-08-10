/**
 * #434: "restore hangs forever in `applying`, and cancel is refused."
 *
 * The reported symptom had nothing to do with the function the issue blamed.
 * `runApply` stopped the service unconditionally and always started it back, so
 * a service whose real container is owned by the DEPLOYMENT (single-app
 * projects: `service_deployment` has no row, which is what
 * `liveContainerIdForService` reads) reached `startService` with a null
 * containerId — which throws on docker — after the extract had already run. The
 * row could never reach a terminal state.
 *
 * Three things had to change together, and this file pins all three:
 *
 *   resolve   — the handle falls back to `deployment.containerId`, but only where
 *               the two cannot differ (dial-able ref, exactly one service row).
 *   gate      — stop only what is running, start only what we stopped. A volume
 *               restore mounts the volume into a separate helper, so a stopped or
 *               container-less service is a legitimate target, not an error.
 *   preflight — the genuinely unrunnable shapes fail in PREPARE, in seconds,
 *               naming what is missing. That is the "fast clear failure" the
 *               issue asked for, and it is why fixing the hang alone would have
 *               been a worse bug: a guaranteed failure instead of an infinite wait.
 *
 * The executor is the REAL DockerBackupExecutor over a fake daemon, because
 * `listSources`' two-source-of-truth behaviour (a live container's mounts vs the
 * DB's declared volumes under project-scoped names) is exactly what the
 * preflight reasons about, and the ids the two tiers produce differ. Only
 * `receiveStream` is replaced — with a stand-in that keeps its target resolution
 * and drops only the helper container. The extract itself belongs to the
 * adapters tests and the real-daemon E2E.
 */

import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { matchBackupSource } from "../../../../../packages/adapters/src/backup/common/source-match";
import { DockerBackupExecutor } from "../../../../../packages/adapters/src/backup/executors/docker";
import type {
  ReceiveStreamOpts,
  ServiceHandle,
} from "../../../../../packages/adapters/src/backup/types";

const ARCHIVE = Buffer.from("tar-bytes");

interface Tr {
  status: string;
  patch?: Record<string, unknown>;
}

const h = vi.hoisted(() => ({
  /** Fake daemon: container id → inspect payload. Absent = 404. */
  containers: new Map<string, { Running: boolean; Mounts: unknown[] }>(),
  /** `service.volumes` on the DB row. */
  volumes: [] as string[],
  /** Every service row the project has — the single-row rule keys off this. */
  serviceIds: ["svc_1"] as string[],
  activeDeploymentId: null as string | null,
  depContainerId: null as string | null,
  liveContainerId: null as string | null,
  /** Force listSources to fail, standing in for an unreachable host. */
  probeError: null as string | null,
  artifacts: [] as unknown[],
  /** Ordered log of everything that touches the target. */
  calls: [] as string[],
  transitions: [] as Tr[],
  row: null as Record<string, unknown> | null,
  waiters: [] as Array<{ pred: (t: Tr) => boolean; resolve: (t: Tr) => void }>,
}));

vi.mock("@repo/db", () => ({
  repos: {
    backupRun: {
      findById: async () => ({
        id: "bkr_1",
        status: "succeeded",
        destinationId: "dst_1",
        organizationId: "org_1",
        projectId: "prj_1",
        serviceId: "svc_1",
        sourceKind: "service",
        policyId: null,
        manifestKey: null,
        deletedAt: null,
        artifacts: h.artifacts,
      }),
    },
    backupPolicy: { findById: async () => undefined },
    backupDestination: {
      findById: async () => ({ id: "dst_1", organizationId: "org_1", name: "local" }),
    },
    backupRestore: {
      findActiveByRunId: async () => undefined,
      create: async (row: Record<string, unknown>) => {
        h.row = { ...row };
        return h.row;
      },
      findById: async () => h.row,
      requestCancel: async () => h.row,
      transition: async (_id: string, status: string, patch?: Record<string, unknown>) => {
        const tr: Tr = { status, patch };
        h.transitions.push(tr);
        Object.assign(h.row!, { status }, patch ?? {});
        for (const w of [...h.waiters]) {
          if (w.pred(tr)) {
            h.waiters.splice(h.waiters.indexOf(w), 1);
            w.resolve(tr);
          }
        }
      },
    },
    project: {
      findById: async () => ({
        id: "prj_1",
        name: "shop",
        slug: "shop",
        activeDeploymentId: h.activeDeploymentId,
      }),
      listEnvVars: async () => [],
    },
    service: {
      findById: async () => ({
        id: "svc_1",
        projectId: "prj_1",
        name: "db",
        image: "postgres:16",
        environment: {},
        volumes: h.volumes,
        namespaceVolumes: true,
      }),
      listByProject: async () => h.serviceIds.map((id) => ({ id })),
    },
    deployment: {
      findById: async () => ({ id: "dep_1", containerId: h.depContainerId, meta: {} }),
    },
  },
}));

/**
 * The real executor over a fake daemon, minus the helper container.
 *
 * `receiveStream` keeps the part under test — resolving the recorded source id
 * against what `listSources` can see right now — and records the PHYSICAL volume
 * it resolved to, because restoring into the wrong volume is the failure mode
 * that matching exists to prevent.
 */
class TestExecutor extends DockerBackupExecutor {
  async listSources(service: ServiceHandle) {
    if (h.probeError) throw new Error(h.probeError);
    return super.listSources(service);
  }

  async receiveStream(
    service: ServiceHandle,
    targetSourceId: string,
    body: Readable,
    opts?: ReceiveStreamOpts,
  ): Promise<{ bytesWritten: number }> {
    opts?.signal?.throwIfAborted();
    const source = matchBackupSource(await this.listSources(service), targetSourceId);
    if (!source) {
      throw new Error(`Restore target "${targetSourceId}" not found on service ${service.name}`);
    }
    h.calls.push(`receive:${source.source}`);
    // Drain, so the apply-time hasher sees the whole archive as a real extract
    // would. A stub that ignored the body would silently disable that check.
    for await (const chunk of body) void chunk;
    return { bytesWritten: ARCHIVE.byteLength };
  }
}

const fakeDaemon = {
  getContainer: (id: string) => ({
    inspect: async () => {
      const found = h.containers.get(id);
      if (!found) {
        const err = new Error(`no such container ${id}`) as Error & { statusCode: number };
        err.statusCode = 404;
        throw err;
      }
      return { State: { Running: found.Running }, Mounts: found.Mounts };
    },
    stop: async () => {
      h.calls.push("stop");
      const found = h.containers.get(id);
      if (found) found.Running = false;
    },
    start: async () => {
      h.calls.push("start");
      const found = h.containers.get(id);
      if (found) found.Running = true;
    },
  }),
};

vi.mock("@repo/adapters", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@repo/adapters")>();
  return {
    ...actual,
    resolveDestination: () => ({
      head: async () => ({ sizeBytes: ARCHIVE.byteLength, uploadedAt: new Date(0) }),
      get: async () => Readable.from([ARCHIVE]),
    }),
    resolveExecutor: () => new TestExecutor({ docker: fakeDaemon } as never),
  };
});

vi.mock("../../../src/modules/backups/restore.sse", () => ({
  restoreRunBus: { publish: () => {}, subscribe: () => () => {} },
}));

vi.mock("../../../src/lib/deployment-runtime", () => ({
  resolveDeploymentPlatform: async () => ({ platform: { runtime: { name: "docker" } } }),
  resolveTargetPlatform: async () => ({ runtime: { name: "bare" } }),
}));
vi.mock("../../../src/lib/encryption", () => ({ decryptEnvMap: (v: unknown) => v }));
vi.mock("../../../src/lib/job-runner", () => ({
  getJobRunner: async () => ({ enqueueRun: async () => {} }),
}));
vi.mock("../../../src/lib/notification-dispatcher", () => ({
  notification: { emit: () => {} },
}));
vi.mock("../../../src/modules/backup-destinations/hydrate-server", () => ({
  toAdapterRow: async (row: unknown) => row,
}));
vi.mock("../../../src/modules/services/service-container", () => ({
  liveContainerIdForService: async () => h.liveContainerId,
}));

import { RestoreOrchestrator } from "../../../src/modules/backups/restore.orchestrator";

const TOKEN = "t".repeat(32);
const CTX = { organizationId: "org_1", userId: "usr_1" } as never;
const TERMINAL = ["succeeded", "failed", "cancelled", "server_error"];

/** A volume artifact as the volume producer records it. */
const volumeArtifact = (volumeId: string) => ({
  name: `volume-${volumeId}.tar.zst`,
  key: `org_1/bkr_1/volume-${volumeId}.tar.zst`,
  sha256: null,
  sizeBytes: ARCHIVE.byteLength,
  payloadKind: "volume",
  metadata: { volumeId, compression: "zstd" },
});

function waitFor(pred: (t: Tr) => boolean): Promise<Tr> {
  const already = h.transitions.find(pred);
  if (already) return Promise.resolve(already);
  return new Promise((resolve) => {
    h.waiters.push({ pred, resolve });
  });
}

/** Prepare only — for the shapes that are supposed to die here. */
async function prepare(): Promise<Tr> {
  const settled = waitFor((t) => t.status === "prepared" || TERMINAL.includes(t.status));
  await new RestoreOrchestrator().beginPrepare({
    runId: "bkr_1",
    trigger: { source: "manual", userId: "usr_1" } as never,
    confirmationToken: TOKEN,
  });
  return settled;
}

/** Prepare, then apply, and return the terminal transition. */
async function restore(): Promise<Tr> {
  const orch = new RestoreOrchestrator();
  const prepared = waitFor((t) => t.status === "prepared" || TERMINAL.includes(t.status));
  const { restoreId } = await orch.beginPrepare({
    runId: "bkr_1",
    trigger: { source: "manual", userId: "usr_1" } as never,
    confirmationToken: TOKEN,
  });
  const first = await prepared;
  if (first.status !== "prepared") return first;

  const done = waitFor((t) => TERMINAL.includes(t.status));
  await orch.apply(CTX, restoreId, TOKEN);
  return done;
}

const preparedMeta = () =>
  (h.transitions.find((t) => t.status === "prepared")?.patch?.meta ?? {}) as Record<
    string,
    unknown
  >;

beforeEach(() => {
  h.containers.clear();
  h.volumes = [];
  h.serviceIds = ["svc_1"];
  h.activeDeploymentId = null;
  h.depContainerId = null;
  h.liveContainerId = null;
  h.probeError = null;
  h.artifacts = [];
  h.calls.length = 0;
  h.transitions.length = 0;
  h.row = null;
  h.waiters.length = 0;
});

describe("the unrunnable shapes fail in prepare, in seconds", () => {
  it("names both missing facts when there is no container and no declared volume", async () => {
    // #434's row, exactly: nothing on the host, nothing on the service.
    h.artifacts = [volumeArtifact("openship-shop-pgdata")];

    const last = await prepare();

    expect(last.status).toBe("failed");
    const message = String(last.patch?.errorMessage);
    expect(message).toContain("no running container");
    expect(message).toContain("no volumes recorded");
    // The whole point: it never became the operator's problem to unstick.
    expect(h.transitions.map((t) => t.status)).not.toContain("applying");
    expect(h.calls).toEqual([]);
  });

  it("says the host was unreachable when the host was unreachable", async () => {
    // Same visible outcome (zero sources), a completely different cause — and a
    // different next step for whoever reads it.
    h.volumes = ["pgdata:/var/lib/postgresql/data"];
    h.artifacts = [volumeArtifact("openship-shop-pgdata")];
    h.probeError = "connect ECONNREFUSED /var/run/docker.sock";

    const last = await prepare();

    expect(last.status).toBe("failed");
    const message = String(last.patch?.errorMessage);
    expect(message).toContain("Could not enumerate restore targets");
    expect(message).toContain("ECONNREFUSED");
    expect(message).not.toContain("no volumes recorded");
  });

  it("refuses a dump that has to be piped into a container that isn't there", async () => {
    // Volume restores survive a missing container; a pg_dump replayed INTO the
    // running database process cannot, so it fails before anything is stopped.
    h.volumes = ["pgdata:/var/lib/postgresql/data"];
    h.artifacts = [
      {
        name: "pg_dump.sql.zst",
        key: "org_1/bkr_1/pg_dump.sql.zst",
        sha256: null,
        sizeBytes: ARCHIVE.byteLength,
        payloadKind: "pg_dump",
        metadata: { restoreCommand: "psql" },
      },
    ];

    const last = await prepare();

    expect(last.status).toBe("failed");
    const message = String(last.patch?.errorMessage);
    expect(message).toContain("pg_dump");
    expect(message).toContain("no live container");
    expect(h.calls).toEqual([]);
  });

  it("refuses when the backed-up volume is not one of the visible targets", async () => {
    h.volumes = ["uploads:/app/uploads"];
    h.artifacts = [volumeArtifact("openship-shop-pgdata")];

    const last = await prepare();

    expect(last.status).toBe("failed");
    const message = String(last.patch?.errorMessage);
    expect(message).toContain("openship-shop-pgdata");
    // Naming what IS there is what turns this into an actionable message.
    expect(message).toContain("openship-shop-uploads-0");
  });

  it("refuses an artifact that never recorded which volume it came from", async () => {
    h.volumes = ["pgdata:/var/lib/postgresql/data"];
    h.artifacts = [
      { ...volumeArtifact("openship-shop-pgdata"), metadata: { compression: "zstd" } },
    ];

    const last = await prepare();

    expect(last.status).toBe("failed");
    expect(String(last.patch?.errorMessage)).toContain("records no volume id");
  });
});

describe("a container-less service is a legitimate target", () => {
  it("restores into a DB-declared volume without stopping or starting anything", async () => {
    h.volumes = ["pgdata:/var/lib/postgresql/data"];
    // Recorded from the live container at capture time, so it is the PHYSICAL
    // name; the DB fallback ids the same volume positionally as
    // `openship-shop-pgdata-0`. Resolving across that asymmetry is the
    // difference between restoring and refusing — a run captured while the
    // container was up and restored while it is gone is the common case.
    h.artifacts = [volumeArtifact("openship-shop-pgdata")];

    const last = await restore();

    expect(last.status).toBe("succeeded");
    // Nothing was stopped: there was nothing running, and the extract mounts the
    // volume into its own helper anyway.
    expect(h.calls).toEqual(["receive:openship-shop-pgdata"]);
    expect(preparedMeta().targetContainer).toBe("none");
    expect(preparedMeta().targetSources).toBe(1);
  });

  it("leaves a deliberately-stopped container stopped", async () => {
    h.activeDeploymentId = "dep_1";
    h.liveContainerId = "c_stopped";
    h.containers.set("c_stopped", {
      Running: false,
      Mounts: [
        { Type: "volume", Name: "openship-shop-pgdata", Destination: "/var/lib/postgresql/data" },
      ],
    });
    h.artifacts = [volumeArtifact("openship-shop-pgdata")];

    const last = await restore();

    expect(last.status).toBe("succeeded");
    // The old code started it unconditionally: a restore resurrected a service
    // the operator had deliberately taken down.
    expect(h.calls).toEqual(["receive:openship-shop-pgdata"]);
    expect(h.containers.get("c_stopped")!.Running).toBe(false);
  });

  it("stops and restarts a running container, in that order", async () => {
    h.activeDeploymentId = "dep_1";
    h.liveContainerId = "c_live";
    h.containers.set("c_live", {
      Running: true,
      Mounts: [
        { Type: "volume", Name: "openship-shop-pgdata", Destination: "/var/lib/postgresql/data" },
      ],
    });
    h.artifacts = [volumeArtifact("openship-shop-pgdata")];

    const last = await restore();

    expect(last.status).toBe("succeeded");
    expect(h.calls).toEqual(["stop", "receive:openship-shop-pgdata", "start"]);
    expect(h.containers.get("c_live")!.Running).toBe(true);
  });
});

describe("the deployment-managed container fallback", () => {
  it("finds the container a single-app project's deploy owns", async () => {
    // `service_deployment` has no row for it — the shape that used to reach
    // startService(null) and wedge the row in `applying`.
    h.activeDeploymentId = "dep_1";
    h.depContainerId = "c_app";
    h.liveContainerId = null;
    h.serviceIds = ["svc_1"];
    h.containers.set("c_app", {
      Running: true,
      Mounts: [{ Type: "volume", Name: "openship-shop-data", Destination: "/data" }],
    });
    h.artifacts = [volumeArtifact("openship-shop-data")];

    const last = await restore();

    expect(last.status).toBe("succeeded");
    expect(h.calls).toEqual(["stop", "receive:openship-shop-data", "start"]);
    expect(preparedMeta().targetContainer).toBe("live");
  });

  it("does not guess when the project has more than one service row", async () => {
    // On compose, `deployment.containerId` is the PRIMARY service's container —
    // adopting it here would restore one service's backup into another's volume.
    h.activeDeploymentId = "dep_1";
    h.depContainerId = "c_primary";
    h.serviceIds = ["svc_1", "svc_2"];
    h.containers.set("c_primary", {
      Running: true,
      Mounts: [{ Type: "volume", Name: "openship-shop-wrong", Destination: "/data" }],
    });
    h.volumes = ["pgdata:/var/lib/postgresql/data"];
    h.artifacts = [volumeArtifact("openship-shop-pgdata")];

    const last = await restore();

    expect(last.status).toBe("succeeded");
    // Resolved from the DB's declared volumes instead, and c_primary was never
    // touched.
    expect(h.calls).toEqual(["receive:openship-shop-pgdata"]);
    expect(h.containers.get("c_primary")!.Running).toBe(true);
    expect(preparedMeta().targetContainer).toBe("none");
  });

  it("refuses the compose sentinel as a container ref", async () => {
    h.activeDeploymentId = "dep_1";
    h.depContainerId = "compose"; // COMPOSE_SENTINEL — not a dial-able id
    h.volumes = ["pgdata:/var/lib/postgresql/data"];
    h.artifacts = [volumeArtifact("openship-shop-pgdata")];

    const last = await restore();

    expect(last.status).toBe("succeeded");
    expect(h.calls).toEqual(["receive:openship-shop-pgdata"]);
    expect(preparedMeta().targetContainer).toBe("none");
  });

  it("refuses a static release directory as a container ref", async () => {
    h.activeDeploymentId = "dep_1";
    h.depContainerId = "/var/lib/openship/static/shop/rel_1";
    h.volumes = ["pgdata:/var/lib/postgresql/data"];
    h.artifacts = [volumeArtifact("openship-shop-pgdata")];

    const last = await restore();

    expect(last.status).toBe("succeeded");
    expect(preparedMeta().targetContainer).toBe("none");
  });

  it("degrades to the declared volumes when the adopted ref is stale", async () => {
    // A redeploy replaced the container since the deployment row was written.
    // The ref is dial-able but 404s, so listSources falls back to the DB and
    // isRunning reports false — which is why a stale ref is harmless rather than
    // something worth a host round-trip to pre-validate.
    h.activeDeploymentId = "dep_1";
    h.depContainerId = "c_gone";
    h.volumes = ["pgdata:/var/lib/postgresql/data"];
    h.artifacts = [volumeArtifact("openship-shop-pgdata")];

    const last = await restore();

    expect(last.status).toBe("succeeded");
    expect(h.calls).toEqual(["receive:openship-shop-pgdata"]);
  });
});
