/**
 * The event accelerator's contract is about RATE, not about classification.
 *
 * It never decides anything — `onEvent` doesn't even read the event — so there is
 * nothing here about whether a container is broken. What can go wrong is arithmetic
 * on timers: a burst of events becoming a burst of sweeps, a flapping container
 * hammering a daemon, a fault that reaches only one observation and then waits 60s
 * for its second, a stream that drops and never comes back, or a subscription that
 * keeps a pooled SSH connection alive forever after nothing needs it.
 *
 * So every assertion below is a count of `runHealthWatch` calls, or of SSH
 * retain/release pairs, at a specific point on a fake clock.
 *
 * `runHealthWatch` itself is mocked: what the sweep does with a filtered run is
 * asserted in health-watch.test.ts, and importing it for real would drag the db and
 * runtime graphs into a suite about setTimeout.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/** Mirrors container-events.ts. Duplicated so a timing change breaks a test. */
const DEBOUNCE_MS = 3_000;
const FOLLOW_UP_MS = 6_000;
const MIN_RUN_GAP_MS = 10_000;
const LEASE_MS = 150_000;
const RECONNECT_MIN_MS = 1_000;

interface Summary {
  pending: number;
  opened: number;
  errors: number;
}
const ZERO: Summary = { pending: 0, opened: 0, errors: 0 };

const h = vi.hoisted(() => ({
  run: vi.fn(),
  resolve: vi.fn(),
  retain: vi.fn(),
  release: vi.fn(),
  target: "selfhosted" as string,
  disabled: false,
}));

vi.mock("./health-watch", () => ({
  runHealthWatch: h.run,
  // Mirrors health-watch.ts's own helpers (asserted against the real pair by the
  // round-trip test there). Kept inline so this suite doesn't import the sweep.
  watchGroupKey: (serverId: string | null, organizationId: string) =>
    `${serverId ?? "__local__"}::${organizationId}`,
  parseWatchGroupKey: (key: string) => {
    const split = key.indexOf("::");
    const serverId = split < 0 ? key : key.slice(0, split);
    return {
      serverId: serverId === "__local__" ? null : serverId,
      organizationId: split < 0 ? "" : key.slice(split + 2),
    };
  },
}));

vi.mock("../../config/env", () => ({
  env: {
    get OPENSHIP_DISABLE_CONTAINER_EVENTS() {
      return h.disabled;
    },
  },
}));

vi.mock("@repo/adapters", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@repo/adapters")>()),
  getPlatform: () => ({ target: h.target }),
}));
vi.mock("../../lib/deployment-runtime", () => ({ resolveDeploymentRuntimeForRead: h.resolve }));
vi.mock("../../lib/ssh-manager", () => ({
  sshManager: { retain: h.retain, release: h.release },
}));

// ─── A daemon whose event stream we drive by hand ────────────────────────────

interface Stream {
  /** Push one transition. Its contents are deliberately irrelevant. */
  fire: (containerId?: string) => void;
  /** The daemon (or the SSH bridge under it) hung up. */
  end: (err?: Error | null) => void;
  stopped: boolean;
}

interface Box {
  runtime: unknown;
  streams: Stream[];
  live: () => Stream;
  attempts: number;
  disposes: number;
}

function makeBox(opts: { supportsEvents?: boolean; failConnect?: boolean } = {}): Box {
  const box: Box = {
    runtime: null,
    streams: [],
    live: () => box.streams[box.streams.length - 1]!,
    attempts: 0,
    disposes: 0,
  };
  box.runtime = {
    supports: (cap: string) => opts.supportsEvents !== false && cap === "containerEvents",
    watchContainerEvents:
      opts.supportsEvents === false
        ? undefined
        : async (handlers: {
            onEvent: (e: { containerId: string; action: string; atSeconds: number }) => void;
            onClose: (err: Error | null) => void;
          }) => {
            box.attempts++;
            if (opts.failConnect) throw new Error("bridge refused");
            const stream: Stream = {
              stopped: false,
              fire: (containerId = "container00001") =>
                handlers.onEvent({ containerId, action: "die", atSeconds: 1 }),
              end: (err = null) => handlers.onClose(err),
            };
            box.streams.push(stream);
            return () => {
              stream.stopped = true;
            };
          },
    dispose: async () => {
      box.disposes++;
    },
  };
  return box;
}

const boxes = new Map<string | null, Box>();

function box(serverId: string | null): Box {
  const existing = boxes.get(serverId);
  if (existing) return existing;
  const fresh = makeBox();
  boxes.set(serverId, fresh);
  return fresh;
}

const key = (serverId: string | null) => `${serverId ?? "__local__"}::org1`;

// ─── Driving the clock ───────────────────────────────────────────────────────

/** Settle the promise chains behind a `void connect()` / a finished sweep. */
async function flush() {
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(0);
}

async function advance(ms: number) {
  await vi.advanceTimersByTimeAsync(ms);
}

/** One full sweep's worth of lease renewal, as `runHealthWatch` would issue it. */
async function renew(keys: string[]) {
  const { renewEventWatchers } = await import("./container-events");
  await renewEventWatchers(keys);
  await flush();
}

beforeEach(async () => {
  // Import BEFORE installing fake timers. Module loading is real async work that can
  // want a real timer, and this suite's first `beforeEach` pays the whole
  // transform+resolve cost — under a parallel `turbo run test` that exceeded the 10s
  // hook timeout, so the suite failed only when the rest of the repo ran alongside it.
  const { __resetContainerEventWatchers } = await import("./container-events");
  vi.useFakeTimers();
  __resetContainerEventWatchers();
  boxes.clear();
  h.target = "selfhosted";
  h.disabled = false;
  h.run.mockReset();
  h.run.mockResolvedValue(ZERO);
  h.retain.mockClear();
  h.release.mockClear();
  h.resolve.mockReset();
  h.resolve.mockImplementation(async (dep: { meta?: Record<string, unknown> }) => {
    const serverId = (dep.meta?.serverId as string | undefined) ?? null;
    return { runtime: box(serverId).runtime, serverId };
  });
});

afterEach(() => {
  vi.useRealTimers();
});

// ─── Subscribing ─────────────────────────────────────────────────────────────

describe("subscribing", () => {
  it("opens one stream per box and reads its state once it is up", async () => {
    await renew([key("srv1")]);

    expect(box("srv1").streams).toHaveLength(1);
    expect(h.retain).toHaveBeenCalledWith("srv1");
    // Not immediately: whatever prompted the connect is still settling.
    expect(h.run).not.toHaveBeenCalled();

    await advance(DEBOUNCE_MS);
    // A connect is itself a reason to read state — anything that changed while we
    // weren't listening has no event left to replay.
    expect(h.run).toHaveBeenCalledTimes(1);
    expect(h.run.mock.calls[0]?.[0]).toEqual({ onlyServerKeys: new Set([key("srv1")]) });
  });

  it("treats a second renewal as a lease renewal, not a second stream", async () => {
    await renew([key("srv1")]);
    await advance(DEBOUNCE_MS);
    h.run.mockClear();

    await renew([key("srv1")]);
    await renew([key("srv1")]);

    expect(box("srv1").streams).toHaveLength(1);
    expect(h.retain).toHaveBeenCalledTimes(1);
    expect(h.run).not.toHaveBeenCalled();
  });

  it("needs no SSH hold for the local daemon", async () => {
    await renew([key(null)]);

    expect(box(null).streams).toHaveLength(1);
    expect(h.retain).not.toHaveBeenCalled();
  });

  it("drops a box whose runtime cannot stream events, holding nothing", async () => {
    boxes.set("srv1", makeBox({ supportsEvents: false }));

    await renew([key("srv1")]);

    expect(box("srv1").streams).toHaveLength(0);
    expect(box("srv1").disposes).toBe(1);
    expect(h.retain).not.toHaveBeenCalled();
    await advance(60_000);
    expect(h.run).not.toHaveBeenCalled();
  });
});

// ─── Rate ────────────────────────────────────────────────────────────────────

describe("one sweep per burst", () => {
  it("coalesces a burst of events into a single sweep", async () => {
    await renew([key("srv1")]);
    await advance(DEBOUNCE_MS);
    h.run.mockClear();

    // A `docker stop` emits kill+die+stop; a redeploy four events per container.
    const stream = box("srv1").live();
    stream.fire();
    stream.fire();
    stream.fire("someone-elses-container");
    stream.fire();
    stream.fire();

    await advance(DEBOUNCE_MS);
    // Floored: the connect read landed a moment ago.
    expect(h.run).not.toHaveBeenCalled();

    await advance(MIN_RUN_GAP_MS - DEBOUNCE_MS);
    expect(h.run).toHaveBeenCalledTimes(1);
    // Same request whichever container moved — there is no container→workload index
    // here on purpose; the sweep re-reads the whole box anyway.
    expect(h.run.mock.calls[0]?.[0]).toEqual({ onlyServerKeys: new Set([key("srv1")]) });
  });

  it("holds a continuously flapping box to the floor", async () => {
    await renew([key("srv1")]);
    await advance(DEBOUNCE_MS);
    h.run.mockClear();

    // A crash-looping container, or a box running CI, emits events without pause.
    const stream = box("srv1").live();
    for (let i = 0; i < 120; i++) {
      stream.fire();
      await advance(500);
    }

    // One minute of unbroken churn buys ~6 sweeps, not 120.
    expect(h.run.mock.calls.length).toBeLessThanOrEqual(7);
    expect(h.run.mock.calls.length).toBeGreaterThanOrEqual(5);
  });

  it("keeps at most one out-of-band sweep outstanding for a slow box", async () => {
    await renew([key("srv1")]);
    await advance(DEBOUNCE_MS);
    h.run.mockClear();

    // A box whose `docker ps -a` takes 30s — a laggy bridge, or a sweep queued behind
    // three other boxes on the shared chain. The floor is measured from when a run
    // FINISHES: stamping it at enqueue let the floor elapse while nothing had been
    // read yet, so each further event appended another identical run, and they drained
    // as a burst with the next scheduled full sweep stuck behind them.
    const READ_MS = 30_000;
    const CHURN = 60;
    const CHURN_GAP_MS = 400;
    h.run.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve(ZERO), READ_MS)),
    );

    const stream = box("srv1").live();
    stream.fire();
    await advance(MIN_RUN_GAP_MS);
    expect(h.run).toHaveBeenCalledTimes(1);

    // 24s of unbroken churn while that read is still outstanding. The run in flight
    // re-reads the whole box anyway, so all of it collapses into ONE more sweep.
    for (let i = 0; i < CHURN; i++) {
      stream.fire();
      await advance(CHURN_GAP_MS);
    }
    expect(h.run).toHaveBeenCalledTimes(1);

    // The read lands. Nothing is eligible yet — the floor starts HERE, not at the
    // moment this run was queued 30s ago.
    await advance(READ_MS - CHURN * CHURN_GAP_MS);
    expect(h.run).toHaveBeenCalledTimes(1);
    await advance(MIN_RUN_GAP_MS - 1);
    expect(h.run).toHaveBeenCalledTimes(1);

    await advance(1);
    expect(h.run).toHaveBeenCalledTimes(2);
  });
});

// ─── The second observation ──────────────────────────────────────────────────

describe("follow-up", () => {
  it("takes the second observation itself when a fault is unconfirmed", async () => {
    h.run.mockResolvedValueOnce({ ...ZERO, pending: 1 });

    await renew([key("srv1")]);
    await advance(DEBOUNCE_MS);
    expect(h.run).toHaveBeenCalledTimes(1);

    // Deliberately NOT held to the 10s floor: this is the second half of an
    // observation pair, and the whole point is confirming at ~10s instead of ~90s.
    await advance(FOLLOW_UP_MS);
    expect(h.run).toHaveBeenCalledTimes(2);

    // The second observation came back clean, so nothing further is owed.
    await advance(120_000);
    expect(h.run).toHaveBeenCalledTimes(2);
  });

  it("schedules no follow-up when the sweep found nothing pending", async () => {
    await renew([key("srv1")]);
    await advance(DEBOUNCE_MS);
    expect(h.run).toHaveBeenCalledTimes(1);

    await advance(120_000);
    expect(h.run).toHaveBeenCalledTimes(1);
  });

  it("lets an event that arrived mid-read ride along with the follow-up", async () => {
    await renew([key("srv1")]);
    await advance(DEBOUNCE_MS);
    h.run.mockClear();

    const READ_MS = 5_000;
    h.run.mockImplementationOnce(
      () => new Promise((resolve) => setTimeout(() => resolve({ ...ZERO, pending: 1 }), READ_MS)),
    );

    const stream = box("srv1").live();
    stream.fire();
    await advance(MIN_RUN_GAP_MS);
    expect(h.run).toHaveBeenCalledTimes(1);

    // Something moved while the read was in flight. A follow-up is a sweep of this
    // same group, so it already covers whatever arrived — queuing both would spend two
    // reads answering one question.
    stream.fire();
    await advance(READ_MS);
    await advance(FOLLOW_UP_MS);
    expect(h.run).toHaveBeenCalledTimes(2);

    await advance(120_000);
    expect(h.run).toHaveBeenCalledTimes(2);
  });

  it("gives up after two follow-ups and leaves it to the scheduled poll", async () => {
    // A fault that never agrees with itself — e.g. a container flapping between
    // exited and running faster than the sweep can see it twice.
    h.run.mockResolvedValue({ ...ZERO, pending: 1 });

    await renew([key("srv1")]);
    await advance(DEBOUNCE_MS);
    await advance(FOLLOW_UP_MS);
    await advance(FOLLOW_UP_MS);
    expect(h.run).toHaveBeenCalledTimes(3);

    await advance(120_000);
    expect(h.run).toHaveBeenCalledTimes(3);
  });
});

// ─── Losing the stream ───────────────────────────────────────────────────────

describe("reconnect", () => {
  it("releases the connection, reconnects, and reads state once it is back", async () => {
    await renew([key("srv1")]);
    await advance(DEBOUNCE_MS);
    h.run.mockClear();

    box("srv1").live().end(new Error("ssh: connection reset by peer"));
    await flush();
    // The SSH hold goes back to the pool immediately — a dead stream must not pin a
    // connection for the length of the backoff.
    expect(h.release).toHaveBeenCalledWith("srv1");
    expect(box("srv1").disposes).toBe(1);

    await advance(RECONNECT_MIN_MS - 1);
    expect(box("srv1").streams).toHaveLength(1);

    await advance(1);
    await flush();
    expect(box("srv1").streams).toHaveLength(2);
    expect(h.retain).toHaveBeenCalledTimes(2);

    // And exactly one read on the way back, floored like any other event-driven run.
    await advance(MIN_RUN_GAP_MS);
    expect(h.run).toHaveBeenCalledTimes(1);
  });

  it("backs off exponentially while the connect keeps failing", async () => {
    boxes.set("srv1", makeBox({ failConnect: true }));

    await renew([key("srv1")]);
    expect(box("srv1").attempts).toBe(1);

    await advance(1_000);
    await flush();
    expect(box("srv1").attempts).toBe(2);

    // Now 2s, not 1s.
    await advance(1_000);
    await flush();
    expect(box("srv1").attempts).toBe(2);
    await advance(1_000);
    await flush();
    expect(box("srv1").attempts).toBe(3);

    // Every failed attempt handed its hold back — a box that will not stay connected
    // must not accumulate retains on the pool.
    expect(h.retain).toHaveBeenCalledTimes(3);
    expect(h.release).toHaveBeenCalledTimes(3);
  });

  it("does not reconnect a stream whose lease already lapsed", async () => {
    await renew([key("srv1")]);
    await advance(DEBOUNCE_MS);
    h.run.mockClear();

    await advance(LEASE_MS + 1_000);
    box("srv1").live().end(new Error("gone"));
    await flush();

    await advance(60_000);
    expect(box("srv1").streams).toHaveLength(1);
    expect(h.release).toHaveBeenCalledWith("srv1");
    expect(h.run).not.toHaveBeenCalled();
  });
});

// ─── Lifecycle is the lease ──────────────────────────────────────────────────

describe("lease", () => {
  it("closes the stream and hands back the connection once the lease lapses", async () => {
    await renew([key("srv1")]);
    await advance(DEBOUNCE_MS);
    const stream = box("srv1").live();
    h.run.mockClear();

    await advance(LEASE_MS + 1_000);
    // A full sweep that no longer enumerates this box — its last project was deleted,
    // disabled, or moved to cloud. Idempotent with the expiry that already fired.
    await renew([]);

    expect(stream.stopped).toBe(true);
    expect(box("srv1").disposes).toBe(1);
    expect(h.release).toHaveBeenCalledWith("srv1");

    // And a late event from the dead stream buys nothing.
    stream.fire();
    await advance(60_000);
    expect(h.run).not.toHaveBeenCalled();
  });

  it("drains itself when the sweep stops calling, without being asked", async () => {
    // The health-watch job is turned off, so `renewEventWatchers` is never called
    // again — there is no next sweep to notice the lease lapsed. Expiring only inside
    // that function therefore left the streams open forever, and every event on them
    // still ran a sweep and still notified, with monitoring switched off.
    await renew([key("srv1")]);
    await advance(DEBOUNCE_MS);
    const stream = box("srv1").live();
    h.run.mockClear();

    await advance(LEASE_MS + 1_000);

    expect(stream.stopped).toBe(true);
    expect(box("srv1").disposes).toBe(1);
    expect(h.release).toHaveBeenCalledWith("srv1");

    // And nothing it emits afterwards buys a sweep.
    stream.fire();
    await advance(60_000);
    expect(h.run).not.toHaveBeenCalled();
  });

  it("survives a box disappearing for a tick or two", async () => {
    await renew([key("srv1")]);
    await advance(DEBOUNCE_MS);
    const stream = box("srv1").live();

    // Gate 1 skips a project while its deploy is in flight, so its group vanishes
    // from a sweep or two. Tearing down an SSH bridge on that churn would cost more
    // than the idle stream does.
    await advance(60_000);
    await renew([]);
    await advance(60_000);
    await renew([key("srv1")]);

    expect(stream.stopped).toBe(false);
    expect(box("srv1").streams).toHaveLength(1);
    expect(h.release).not.toHaveBeenCalled();
  });

  it("closes every stream on shutdown", async () => {
    await renew([key("srv1"), key("srv2")]);
    const { stopAllContainerEventWatchers } = await import("./container-events");

    await stopAllContainerEventWatchers();

    expect(box("srv1").live().stopped).toBe(true);
    expect(box("srv2").live().stopped).toBe(true);
    expect(h.release.mock.calls.map((c) => c[0]).sort()).toEqual(["srv1", "srv2"]);
  });
});

// ─── Gates ───────────────────────────────────────────────────────────────────

describe("gates", () => {
  it("subscribes to nothing when the escape hatch is set", async () => {
    h.disabled = true;

    await renew([key("srv1")]);

    expect(h.resolve).not.toHaveBeenCalled();
    await advance(60_000);
    expect(h.run).not.toHaveBeenCalled();
  });

  it("drains live streams when the escape hatch is set mid-flight", async () => {
    await renew([key("srv1")]);
    const stream = box("srv1").live();

    h.disabled = true;
    await renew([key("srv1")]);

    expect(stream.stopped).toBe(true);
    expect(h.release).toHaveBeenCalledWith("srv1");
  });

  it("subscribes to nothing on a target with no event feed", async () => {
    // Desktop has no always-on poller to accelerate; Oblien exposes no event feed.
    for (const target of ["desktop", "cloud"]) {
      h.target = target;
      await renew([key("srv1")]);
    }

    expect(h.resolve).not.toHaveBeenCalled();
  });

  it("ignores an org-less group key rather than resolving a runtime for it", async () => {
    await renew(["srv1"]);

    expect(h.resolve).not.toHaveBeenCalled();
  });
});
