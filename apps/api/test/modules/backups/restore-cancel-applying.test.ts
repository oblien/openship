/**
 * Cancelling a restore, and what the operator is promised when they do.
 *
 * Before #434 there were two lies here. `applying` was refused outright, so a
 * wedged apply had no way out at all — and it blocks project deletion, so the
 * project had no way out either. And `preparing` was worse than refused: cancel
 * wrote the row while runPrepare carried on and overwrote it with `prepared`, so
 * the operator watched their own cancel undo itself.
 *
 * What replaced it turns on one fact: `clearTarget: true` empties the volume
 * before the extract. So "cancel" means two completely different things either
 * side of the first write, and the row has to say which one happened:
 *
 *   before  → `cancelled`, destructive: false, the service put back the way we
 *             found it. Nothing was lost.
 *   after   → `cancelled`, partialWrite, and the service DELIBERATELY left
 *             stopped, because starting an app on a half-written volume converts
 *             a clear failure into a silently corrupt running service.
 *
 * The tests below park the apply at each point where that answer changes and
 * cancel it there. What they pin is not "cancel works" but which of the two
 * promises each interruption point produces — including the two that decline to
 * cancel at all (past the last write, and cancel on an already-terminal row),
 * and the forced path that exists so a wedged row can always be cleared.
 */

import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

const ARCHIVE = Buffer.from("tar-bytes");

interface Tr {
  status: string;
  patch?: Record<string, unknown>;
}

/** A one-shot rendezvous: the code under test parks, the test releases it. */
interface Gate {
  hit: Promise<void>;
  arrive: () => Promise<void>;
  release: () => void;
}

const h = vi.hoisted(() => {
  const makeGate = (): Gate => {
    let arrived: () => void = () => {};
    const hit = new Promise<void>((r) => {
      arrived = r;
    });
    let go: () => void = () => {};
    const open = new Promise<void>((r) => {
      go = r;
    });
    return {
      hit,
      arrive: async () => {
        arrived();
        await open;
      },
      release: () => go(),
    };
  };
  return {
    makeGate,
    gate: makeGate(),
    /** Which point in the run parks at the gate. */
    gateAt: null as null | "verify" | "stop" | "receive-start" | "receive-end",
    /** Whether an aborted signal makes the extract throw, i.e. whether the cancel
     *  landed mid-stream or after the last byte was already in. */
    abortThrows: true,
    running: false,
    artifacts: [] as unknown[],
    calls: [] as string[],
    transitions: [] as Tr[],
    /** Everything published on the live channel, in order. */
    events: [] as Array<Record<string, unknown>>,
    row: null as Record<string, unknown> | null,
    waiters: [] as Array<{ pred: (t: Tr) => boolean; resolve: (t: Tr) => void }>,
  };
});

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
        h.row = { ...row, meta: null };
        return h.row;
      },
      findById: async () => h.row,
      // Mirrors the repo's `coalesce(cancel_requested_at, now())`: the FIRST
      // press is the one that starts the force-cancel clock, so a second press
      // must not push the deadline back out.
      requestCancel: async () => {
        h.row!.cancelRequested = true;
        h.row!.cancelRequestedAt ??= new Date();
        return h.row;
      },
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
        activeDeploymentId: null,
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
        volumes: ["pgdata:/var/lib/postgresql/data"],
        namespaceVolumes: true,
      }),
      listByProject: async () => [{ id: "svc_1" }],
    },
    deployment: { findById: async () => null },
  },
}));

/**
 * The real volume producer runs against this, so the `signal` handed to
 * `receiveStream` is the one the orchestrator actually plumbs through — the whole
 * reason a cancel doesn't have to wait out a 50GB extract.
 */
vi.mock("@repo/adapters", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@repo/adapters")>();
  return {
    ...actual,
    resolveDestination: () => ({
      head: async () => {
        if (h.gateAt === "verify") await h.gate.arrive();
        return { sizeBytes: ARCHIVE.byteLength, uploadedAt: new Date(0) };
      },
      get: async () => Readable.from([ARCHIVE]),
    }),
    resolveExecutor: () => ({
      runtimeName: "docker",
      listSources: async () => [
        {
          id: "openship-shop-pgdata",
          source: "openship-shop-pgdata",
          target: "/var/lib/postgresql/data",
          type: "volume",
        },
        {
          id: "openship-shop-uploads",
          source: "openship-shop-uploads",
          target: "/app/uploads",
          type: "volume",
        },
      ],
      isRunning: async () => h.running,
      stopService: async () => {
        h.calls.push("stop");
        h.running = false;
        if (h.gateAt === "stop") await h.gate.arrive();
      },
      startService: async () => {
        h.calls.push("start");
        h.running = true;
      },
      receiveStream: async (
        _service: unknown,
        targetSourceId: string,
        body: Readable,
        opts?: { signal?: AbortSignal },
      ) => {
        if (h.gateAt === "receive-start") {
          await h.gate.arrive();
          // Parked BEFORE any byte reached the volume, then released into an
          // aborted signal: the real executor's abort watch rejects here.
          if (h.abortThrows) opts?.signal?.throwIfAborted();
        }
        h.calls.push(`receive:${targetSourceId}`);
        for await (const chunk of body) void chunk;
        if (h.gateAt === "receive-end") {
          await h.gate.arrive();
          if (h.abortThrows) opts?.signal?.throwIfAborted();
        }
        return { bytesWritten: ARCHIVE.byteLength };
      },
    }),
  };
});

vi.mock("../../../src/modules/backups/restore.sse", () => ({
  restoreRunBus: {
    publish: (_id: string, event: Record<string, unknown>) => {
      h.events.push(event);
    },
    subscribe: () => () => {},
  },
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
  liveContainerIdForService: async () => null,
}));

import { RestoreOrchestrator } from "../../../src/modules/backups/restore.orchestrator";

const TOKEN = "t".repeat(32);
const CTX = { organizationId: "org_1", userId: "usr_1" } as never;
const TERMINAL = ["succeeded", "failed", "cancelled", "server_error"];

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

type CancelOutcome = Awaited<ReturnType<RestoreOrchestrator["cancel"]>>;

/**
 * Run to the gate, cancel there, release, and report both what cancel() answered
 * on the spot and where the row ended up.
 */
async function cancelAtGate(
  gateAt: NonNullable<typeof h.gateAt>,
  opts?: { abortThrows?: boolean },
): Promise<{ last: Tr; outcome: CancelOutcome }> {
  h.gateAt = gateAt;
  h.abortThrows = opts?.abortThrows ?? true;
  const orch = new RestoreOrchestrator();

  const prepared = waitFor((t) => t.status === "prepared" || TERMINAL.includes(t.status));
  const { restoreId } = await orch.beginPrepare({
    runId: "bkr_1",
    trigger: { source: "manual", userId: "usr_1" } as never,
    confirmationToken: TOKEN,
  });

  const done = waitFor((t) => TERMINAL.includes(t.status));
  if (gateAt !== "verify") {
    const first = await prepared;
    if (first.status !== "prepared") throw new Error(`prepare ended as ${first.status}`);
    await orch.apply(CTX, restoreId, TOKEN);
  }

  await h.gate.hit;
  const outcome = await orch.cancel(CTX, restoreId);
  h.gate.release();
  return { last: await done, outcome };
}

const metaOf = (tr: Tr) => (tr.patch?.meta ?? {}) as Record<string, unknown>;

beforeEach(() => {
  h.gate = h.makeGate();
  h.gateAt = null;
  h.abortThrows = true;
  h.running = false;
  h.artifacts = [volumeArtifact("openship-shop-pgdata")];
  h.calls.length = 0;
  h.transitions.length = 0;
  h.events.length = 0;
  h.row = null;
  h.waiters.length = 0;
});

describe("cancelling before the first write costs nothing", () => {
  it("does not let `prepared` overwrite a cancel taken during prepare", async () => {
    // The old bug, verbatim: cancel wrote the row, runPrepare kept going and
    // stamped `prepared` over it, and the restore was applyable again.
    const { last, outcome } = await cancelAtGate("verify");

    expect(outcome).toMatchObject({ accepted: true, status: "cancelled", destructive: false });
    expect(last.status).toBe("cancelled");
    // Two cancelled transitions = cancel() wrote one and runPrepare unwound into
    // the other, which is the proof that prepare RAN TO COMPLETION after the
    // cancel and still declined to stamp `prepared`.
    await vi.waitFor(() =>
      expect(h.transitions.filter((t) => t.status === "cancelled")).toHaveLength(2),
    );
    expect(h.transitions.map((t) => t.status)).not.toContain("prepared");
    expect(h.calls).toEqual([]);
  });

  it("puts a service it stopped back up", async () => {
    h.running = true;

    const { last, outcome } = await cancelAtGate("stop");

    // Accepted, but not terminal yet — the apply is between checkpoints, so the
    // UI gets "cancelling…" rather than a status it can trust.
    expect(outcome).toMatchObject({ accepted: true, status: "applying", forced: false });
    expect(last.status).toBe("cancelled");
    expect(metaOf(last).destructive).toBe(false);
    expect(last.patch?.errorMessage).toBeUndefined();
    // Stopped, then started again — and nothing in between.
    expect(h.calls).toEqual(["stop", "start"]);
    expect(h.running).toBe(true);
  });

});

describe("cancelling mid-write says so, and leaves the service down", () => {
  it("reports partial data and does not restart the service", async () => {
    h.running = true;

    const { last } = await cancelAtGate("receive-start");

    expect(last.status).toBe("cancelled");
    const message = String(last.patch?.errorMessage);
    expect(message).toContain("had begun writing");
    expect(message).toContain('volume "openship-shop-pgdata"');
    expect(message).toContain("partial data");
    expect(metaOf(last)).toMatchObject({
      destructive: true,
      partialWrite: true,
      serviceLeftStopped: true,
    });
    // The load-bearing assertion of this whole file: no restart. An app started
    // on a half-written volume looks healthy and serves corrupt data.
    expect(h.calls).toEqual(["stop"]);
    expect(h.running).toBe(false);
  });

  it("never starts a service that was already down", async () => {
    // Same interruption, but nothing was running to begin with. The partial-write
    // path declines the restart on its own; this pins that the "start back what we
    // stopped" bookkeeping agrees with it rather than fighting it.
    h.running = false;

    const { last } = await cancelAtGate("receive-start");

    expect(last.status).toBe("cancelled");
    expect(metaOf(last)).toMatchObject({ partialWrite: true, serviceLeftStopped: true });
    expect(h.calls).toEqual([]);
  });

  it("names the volume already written when a later one is cancelled", async () => {
    // Multi-volume restore stopped at checkpoint 3: the first volume is done and
    // wiped-and-replaced, the second was never touched. Reporting this as a clean
    // cancel would be a straightforward lie.
    h.running = true;
    h.artifacts = [
      volumeArtifact("openship-shop-pgdata"),
      volumeArtifact("openship-shop-uploads"),
    ];

    const { last } = await cancelAtGate("receive-end", { abortThrows: false });

    expect(last.status).toBe("cancelled");
    expect(String(last.patch?.errorMessage)).toContain('volume "openship-shop-pgdata"');
    expect(metaOf(last)).toMatchObject({ partialWrite: true, serviceLeftStopped: true });
    expect(h.calls).toEqual(["stop", "receive:openship-shop-pgdata"]);
    expect(h.running).toBe(false);
  });

  it("tells the UI the point of no return was crossed, before crossing it", async () => {
    // The button switches from "Cancel" to "Abort restore" on this event, so it
    // has to lead the write rather than follow it.
    h.running = true;

    await cancelAtGate("receive-start");

    const firstDestructive = h.events.findIndex((e) => e.destructive === true);
    expect(firstDestructive).toBeGreaterThanOrEqual(0);
    expect(h.events[firstDestructive]).toMatchObject({
      type: "destructive",
      source: 'volume "openship-shop-pgdata"',
    });
  });
});

describe("the two cancels that decline", () => {
  it("finishes a restore whose last byte was already written", async () => {
    // Honoring this would file a complete restore as a partial one — strictly
    // worse for the operator than ignoring a cancel that arrived too late.
    h.running = true;

    const { last } = await cancelAtGate("receive-end", { abortThrows: false });

    expect(last.status).toBe("succeeded");
    expect(metaOf(last)).toMatchObject({
      destructive: true,
      cancelDeclined: "after-last-write",
    });
    expect(h.calls).toEqual(["stop", "receive:openship-shop-pgdata", "start"]);
    expect(h.running).toBe(true);
  });

  it("is idempotent on a row that already finished", async () => {
    h.row = {
      id: "bks_done",
      organizationId: "org_1",
      status: "succeeded",
      confirmationToken: TOKEN,
      meta: { destructive: true },
    };

    const outcome = await new RestoreOrchestrator().cancel(CTX, "bks_done");

    // A double-click on a restore that just finished is not an error worth
    // showing anyone.
    expect(outcome).toEqual({
      accepted: false,
      status: "succeeded",
      destructive: true,
      forced: false,
    });
    expect(h.transitions).toEqual([]);
  });
});

describe("the forced path exists so a wedged row can always be cleared", () => {
  it("force-terminals an apply that ignored its cancel window", async () => {
    // No checkpoint answered — the apply is gone, or stuck somewhere with no
    // checkpoint ahead of it. The row has to become terminal regardless: while
    // it is `applying` it blocks deleting the project.
    h.row = {
      id: "bks_wedged",
      organizationId: "org_1",
      status: "applying",
      confirmationToken: TOKEN,
      cancelRequested: true,
      cancelRequestedAt: new Date(Date.now() - 5 * 60 * 1000),
      meta: { destructive: true, destructiveSource: 'volume "openship-shop-pgdata"' },
    };

    const outcome = await new RestoreOrchestrator().cancel(CTX, "bks_wedged");

    expect(outcome).toMatchObject({ accepted: true, status: "cancelled", forced: true });
    const last = h.transitions.at(-1)!;
    expect(last.status).toBe("cancelled");
    // Identical partial-data wording to the cooperative path, plus the one thing
    // it knows less about: whether the write kept going after this.
    expect(String(last.patch?.errorMessage)).toContain('volume "openship-shop-pgdata"');
    expect(String(last.patch?.errorMessage)).toContain("partial data");
    expect(String(last.patch?.errorMessage)).toContain("force-cancelled");
    expect(metaOf(last)).toMatchObject({
      forced: true,
      destructive: true,
      partialWrite: true,
      serviceLeftStopped: true,
    });
  });

  it("does not force one that has not had its window yet", async () => {
    h.row = {
      id: "bks_fresh",
      organizationId: "org_1",
      status: "applying",
      confirmationToken: TOKEN,
      cancelRequested: true,
      cancelRequestedAt: new Date(Date.now() - 5_000),
      meta: {},
    };

    const outcome = await new RestoreOrchestrator().cancel(CTX, "bks_fresh");

    // Still cooperative: forcing here would report `cancelled` while a `tar -x`
    // was demonstrably still making progress.
    expect(outcome).toMatchObject({ accepted: true, status: "applying", forced: false });
    expect(h.transitions).toEqual([]);
  });

  it("does not let a second press push the force deadline back out", async () => {
    const firstPress = new Date(Date.now() - 5 * 60 * 1000);
    h.row = {
      id: "bks_wedged",
      organizationId: "org_1",
      status: "applying",
      confirmationToken: TOKEN,
      cancelRequested: true,
      cancelRequestedAt: firstPress,
      meta: {},
    };

    await new RestoreOrchestrator().cancel(CTX, "bks_wedged");

    // requestCancel coalesces, so the clock still runs from the first press —
    // otherwise an impatient operator pressing every 30s could never reach the
    // force path at all.
    expect(h.row!.cancelRequestedAt).toBe(firstPress);
    expect(h.transitions.at(-1)!.status).toBe("cancelled");
  });
});
