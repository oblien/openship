import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

/**
 * The HOST channel is pooled, and these tests pin the property that #291 was
 * missing rather than the one that merely looks right.
 *
 * `createHostExecutor()` is a FACTORY: when the API is containerized it builds a
 * NEW SshExecutor to the host on every call, so an unpooled caller leaked one sshd
 * session per call — 8,000+ in a few hours, then OOM. Pooling alone isn't the fix
 * to assert; the fix is that the connection is (a) created once, (b) actually
 * CLOSED when idle, and (c) never closed while a borrower still holds it.
 */

const h = vi.hoisted(() => ({
  created: 0,
  disposed: 0,
  /** Rows by id — `isLocalHostRow` reads `isLocal`. */
  rows: {} as Record<string, { id: string; isLocal: boolean; sshHost?: string } | undefined>,
  makeExecutor: () => ({}) as Record<string, unknown>,
}));

vi.mock("@repo/db", () => ({
  repos: { server: { get: vi.fn(async (id: string) => h.rows[id]) } },
}));

vi.mock("@repo/adapters", async () => ({
  // The REAL error/predicate module, not stand-ins. The gate's contract is that
  // `isHostChannelUnavailableError` recognises what it throws and that
  // `isRetryableRemoteConnectionError` agrees with the executors about which
  // failures are transport failures — local copies would keep passing after either
  // stopped being true. Imported by path because that module is dependency-free;
  // pulling in the package entry point would defeat mocking it.
  ...(await import("../../../../packages/adapters/src/system/errors")),
  // Read at module scope by openship-server-store (imported transitively), so the
  // mock has to carry it or nothing under test loads. Its value is irrelevant here.
  HOST_STATE_DIR: "/root/.openship",
  createHostExecutor: vi.fn(() => {
    h.created += 1;
    return {
      // Only `dispose` matters here; the manager feature-detects the rest.
      dispose: vi.fn(async () => {
        h.disposed += 1;
      }),
    };
  }),
  hostChannelHealth: vi.fn(async () => ({ ok: true, code: "ok" })),
  probeTcp: vi.fn(async () => true),
}));

// isLocalHostRow decides "is this row THIS box". Keyed off the fixture flag so the
// test doesn't depend on env/loopback resolution.
vi.mock("./box-org", () => ({
  isLocalHostRow: vi.fn(async (row: { isLocal?: boolean }) => Boolean(row?.isLocal)),
}));

import { sshManager } from "./ssh-manager";

/** Reach into the pool — there's no public accessor, and the whole point is to
 *  assert the cache state that the leak was a symptom of. */
const pool = () => (sshManager as unknown as { servers: Map<string, unknown> }).servers;

/** Mirrors the module-private pool key for the shared host channel. */
const HOST_KEY = "__openship_host__";

beforeEach(() => {
  h.created = 0;
  h.disposed = 0;
  h.rows = {
    "local-1": { id: "local-1", isLocal: true, sshHost: "127.0.0.1" },
    "local-2": { id: "local-2", isLocal: true, sshHost: "10.0.0.5" },
  };
  for (const key of [...pool().keys()]) {
    (sshManager as unknown as { dropServer: (k: string, f?: boolean) => void }).dropServer(
      key,
      true,
    );
  }
  // Also clears the circuit breaker: probes here deliberately fail, and a cooldown
  // left over from the previous case would answer the next one before it ran.
  sshManager.invalidate();
  h.created = 0;
  h.disposed = 0;
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("host channel pooling", () => {
  it("builds ONE executor across repeated withHostExecutor calls", async () => {
    // The regression shape: this endpoint-style call used to mint a connection each
    // time. Ten calls, one connection.
    const seen = new Set<unknown>();
    for (let i = 0; i < 10; i++) {
      await sshManager.withHostExecutor(async (exec) => {
        seen.add(exec);
        return true;
      });
    }
    expect(h.created).toBe(1);
    expect(seen.size).toBe(1);
    expect(h.disposed).toBe(0);
  });

  it("does not dispose on scope exit — the pool owns the lifetime", async () => {
    // The old idiom required every caller to dispose; the new one must NOT, or two
    // concurrent callers would close each other's connection.
    await sshManager.withHostExecutor(async () => true);
    expect(h.disposed).toBe(0);
  });

  it("dedups concurrent first-acquires instead of orphaning N-1 connections", async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, () => sshManager.withHostExecutor(async (exec) => exec)),
    );
    expect(h.created).toBe(1);
    expect(new Set(results).size).toBe(1);
  });

  it("propagates the acquire failure instead of reporting a phantom success", async () => {
    // createHostExecutor throws by design when the API is containerized with no
    // host channel. Swallowing that is how a caller concludes "host reachable".
    const { createHostExecutor } = await import("@repo/adapters");
    vi.mocked(createHostExecutor).mockImplementationOnce(() => {
      throw new Error("no host channel is configured");
    });
    await expect(sshManager.withHostExecutor(async () => "nope")).rejects.toThrow(
      /no host channel/,
    );
  });
});

describe("host channel is reclaimed, not merely reused", () => {
  it("disposes the connection once idle — the part that actually stops the leak", async () => {
    vi.useFakeTimers();
    await sshManager.withHostExecutor(async () => true);
    expect(h.created).toBe(1);
    expect(h.disposed).toBe(0);

    // Past the idle window: the pool must CLOSE it, or "pooled" just means the leak
    // grows more slowly.
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(h.disposed).toBe(1);

    // And a later caller transparently gets a fresh one.
    vi.useRealTimers();
    await sshManager.withHostExecutor(async () => true);
    expect(h.created).toBe(2);
  });
});

describe("local server rows share the one host channel", () => {
  it("two different local rows do not open two host connections", async () => {
    const a = await sshManager.acquire("local-1");
    const b = await sshManager.acquire("local-2");
    expect(h.created).toBe(1);
    expect(a).toBe(b);
  });

  it("caches the local row WITHOUT claiming it is reachable", async () => {
    // #490: acquiring a local row seeds a borrow marker over an executor that has
    // not dialed anything (ssh2 connects lazily). Treating that entry as proof made
    // probeReachable answer Online for a host whose SSH port was firewalled — the
    // one place an operator would have looked to discover the channel was dead.
    await sshManager.acquire("local-1");
    expect(pool().has("local-1")).toBe(true);
    expect((pool().get("local-1") as { proven?: boolean }).proven).toBeFalsy();
  });

  it("answers probeReachable from the host channel's health, not from the cache", async () => {
    const { hostChannelHealth } = await import("@repo/adapters");
    await sshManager.acquire("local-1");

    vi.mocked(hostChannelHealth).mockResolvedValueOnce({
      ok: false,
      code: "unreachable",
      hint: "blocked",
    });
    expect(await sshManager.probeReachable("local-1")).toBe(false);

    vi.mocked(hostChannelHealth).mockResolvedValueOnce({ ok: true, code: "ok" });
    expect(await sshManager.probeReachable("local-1")).toBe(true);
  });

  it("does not report a deliberately disabled host channel as offline", async () => {
    // `--no-host-control` switches off host-OS operations by choice; the row still
    // deploys through the mounted Docker socket, so Offline would be a lie.
    const { hostChannelHealth } = await import("@repo/adapters");
    vi.mocked(hostChannelHealth).mockResolvedValueOnce({ ok: false, code: "disabled" });
    expect(await sshManager.probeReachable("local-1")).toBe(true);
  });

  it("dropping a BORROWED row never closes the shared connection", async () => {
    // The trap in sharing one executor under several keys: idle-dropping one local
    // row must not end the channel the other row and withHostExecutor still use.
    await sshManager.acquire("local-1");
    await sshManager.acquire("local-2");
    (sshManager as unknown as { dropServer: (k: string, f?: boolean) => void }).dropServer(
      "local-1",
      true,
    );

    expect(h.disposed).toBe(0);
    expect(pool().has("local-1")).toBe(false);
    // Still usable through the other borrower and the channel itself.
    await sshManager.withHostExecutor(async () => true);
    expect(h.created).toBe(1);
  });
});

describe("host channel survives while a borrower is live (the owner/borrower lifecycle)", () => {
  it("never serves a disposed executor when the owner idles under a HOT borrower", async () => {
    // Regression: the top-of-acquire fast path used to return the row's borrow
    // marker and refresh only ITS idle timer — so the owner idled out and disposed
    // the shared executor while the row was still being acquired, and the next
    // acquire handed back a DISPOSED executor. Re-acquiring a local row must keep
    // the owner alive.
    vi.useFakeTimers();
    const a = await sshManager.acquire("local-1");
    expect(h.created).toBe(1);

    // Keep the borrower hot with a cache-hit BEFORE its 5-min window, crossing the
    // owner's ORIGINAL 5-min deadline in the process.
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    await sshManager.acquire("local-1");
    await vi.advanceTimersByTimeAsync(3 * 60_000);

    const b = await sshManager.acquire("local-1");
    expect(h.disposed).toBe(0); // owner never idled out from under the live row
    expect(h.created).toBe(1); // …so it was never rebuilt
    expect(b).toBe(a); // …and the same live executor is still handed out
    vi.useRealTimers();
  });

  it("keeps the shared channel alive across a retain placed BEFORE the first acquire", async () => {
    // The real call order for a stream/deploy is retain(rowId) THEN acquire(rowId);
    // retain can't yet know the row is local, so protection is enforced at drop
    // time. A hold longer than the idle window must not lose the channel.
    vi.useFakeTimers();
    sshManager.retain("local-1");
    await sshManager.acquire("local-1");
    expect(h.created).toBe(1);

    await vi.advanceTimersByTimeAsync(10 * 60_000); // well past the 5-min idle window
    expect(h.disposed).toBe(0); // guard: a borrowing row is retained

    const live = await sshManager.withHostExecutor(async () => "ok");
    expect(live).toBe("ok"); // still the same live channel
    expect(h.created).toBe(1);

    // Releasing re-arms the owner's idle timer, so it IS reclaimed once idle.
    sshManager.release("local-1");
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(h.disposed).toBe(1);
    vi.useRealTimers();
  });
});

describe("diagnoseReachability carries the reason, not just the verdict", () => {
  it("names the address ops DIAL, not the row's display sshHost", async () => {
    // The whole point: the row says 127.0.0.1 (display-only), so a UI keyed off it
    // told operators to check a port that is supposed to be closed, on the wrong
    // machine. The diagnosis names host.docker.internal and the real fix (#490).
    const { hostChannelHealth } = await import("@repo/adapters");
    vi.mocked(hostChannelHealth).mockResolvedValueOnce({
      ok: false,
      code: "unreachable",
      host: "host.docker.internal",
      port: 22,
      target: "root@host.docker.internal:22",
      rule: "sudo ufw allow from 172.18.0.0/16 to any port 22 proto tcp",
      hint: "Nothing answered at root@host.docker.internal:22 …",
    });

    const d = await sshManager.diagnoseReachability("local-1");
    expect(d).toMatchObject({
      reachable: false,
      code: "host_channel_blocked",
      target: "root@host.docker.internal:22",
      port: 22,
      rule: "sudo ufw allow from 172.18.0.0/16 to any port 22 proto tcp",
    });
    expect(d.target).not.toContain("127.0.0.1");
  });

  it("still explains itself once the breaker has opened", async () => {
    // The UI asks WHY at exactly the moment a host op just failed — i.e. when the
    // breaker is open. A bare "cooldown" there would drop the diagnosis on the floor
    // precisely when it's needed.
    const { hostChannelHealth } = await import("@repo/adapters");
    const blocked = {
      ok: false,
      code: "unreachable" as const,
      target: "root@host.docker.internal:22",
      rule: "sudo ufw allow from 172.18.0.0/16 to any port 22 proto tcp",
      hint: "blocked",
    };
    vi.mocked(hostChannelHealth).mockResolvedValueOnce(blocked).mockResolvedValueOnce(blocked);

    // Two failures trip the breaker (FAIL_THRESHOLD = 2).
    await sshManager.diagnoseReachability("local-1");
    await sshManager.diagnoseReachability("local-1");
    vi.mocked(hostChannelHealth).mockClear();

    const d = await sshManager.diagnoseReachability("local-1");
    // No further probe was paid…
    expect(hostChannelHealth).not.toHaveBeenCalled();
    // …and the answer still says what to do about it.
    expect(d).toMatchObject({
      reachable: false,
      code: "host_channel_blocked",
      target: "root@host.docker.internal:22",
      rule: "sudo ufw allow from 172.18.0.0/16 to any port 22 proto tcp",
    });
  });

  it("distinguishes a deliberate opt-out from a broken channel", async () => {
    const { hostChannelHealth } = await import("@repo/adapters");
    vi.mocked(hostChannelHealth).mockResolvedValueOnce({ ok: false, code: "disabled" });
    expect(await sshManager.diagnoseReachability("local-1")).toMatchObject({
      reachable: true,
      code: "host_control_disabled",
    });
  });

  /**
   * #509. `host_channel_blocked` is ONE verdict over several states, and the remedy
   * differs per state — a dial that was dropped wants a firewall rule, a channel that was
   * never provisioned wants `openship up`. So the state has to travel, and the fields
   * that mean "we contacted this" must not be filled in for a channel nothing contacted:
   * the dashboard reads a present `target` as evidence, and reported that nothing answered
   * on an address nothing had ever dialed.
   */
  it("carries the host-channel state, with no endpoint or rule invented for it", async () => {
    const { hostChannelHealth } = await import("@repo/adapters");
    vi.mocked(hostChannelHealth).mockResolvedValueOnce({
      ok: false,
      code: "not_configured",
      hint: "…no host channel…",
    });

    const d = await sshManager.diagnoseReachability("local-1");
    expect(d).toMatchObject({ reachable: false, code: "host_channel_blocked", channel: "not_configured" });
    expect(d.target).toBeUndefined();
    expect(d.host).toBeUndefined();
    expect(d.port).toBeUndefined();
    expect(d.rule).toBeUndefined();
  });

  it("distinguishes an unreachable channel from an unprovisioned one by that state", async () => {
    const { hostChannelHealth } = await import("@repo/adapters");
    vi.mocked(hostChannelHealth).mockResolvedValueOnce({
      ok: false,
      code: "unreachable",
      target: "root@host.docker.internal:22",
      hint: "dropped",
    });
    expect(await sshManager.diagnoseReachability("local-1")).toMatchObject({
      code: "host_channel_blocked",
      channel: "unreachable",
      target: "root@host.docker.internal:22",
    });
  });

  it("does not invent a host-channel story for a remote row", async () => {
    const { hostChannelHealth, probeTcp } = await import("@repo/adapters");
    h.rows["remote-1"] = { id: "remote-1", isLocal: false, sshHost: "203.0.113.9" };
    vi.mocked(probeTcp).mockResolvedValueOnce(false);

    const d = await sshManager.diagnoseReachability("remote-1");
    expect(hostChannelHealth).not.toHaveBeenCalled();
    expect(d).toMatchObject({ reachable: false, code: "unreachable", host: "203.0.113.9", port: 22 });
    expect(d.rule).toBeUndefined();
  });
});

/**
 * #490's third clause: "mark host control as unavailable rather than letting
 * operations fail one at a time".
 *
 * `createHostExecutor()` only CONSTRUCTS — ssh2 dials lazily — so a channel the host
 * firewall drops hands back a healthy-looking executor, and every op that takes it
 * pays its own handshake timeout before failing with a message that names neither the
 * channel nor the fix. What the gate must NOT become is a cache of that verdict: a
 * remembered failure that outlives the firewall rule is its own bug report.
 */
describe("a channel observed to fail is refused, not re-dialed forever", () => {
  /** What a firewalled channel actually throws: ssh2 waiting out a handshake whose
   *  SYN was dropped. Classified by the REAL isRetryableRemoteConnectionError. */
  const handshakeTimeout = () => new Error("Timed out while waiting for handshake");

  const BLOCKED = {
    ok: false as const,
    code: "unreachable" as const,
    host: "host.docker.internal",
    port: 22,
    target: "root@host.docker.internal:22",
    cause: "timeout" as const,
    // Shaped like the real thing: hint is prose, rule is a command, and they are
    // separate fields. So the assertions below pin that the gate COMPOSES them into the
    // error — without that, the rule reaches the dashboard banner and never the deploy
    // log, which is where an operator is standing when a host op dies.
    rule: "sudo ufw allow from 172.18.0.0/16 to any port 22 proto tcp",
    hint: "root@host.docker.internal:22 — no response, not even a refusal (ETIMEDOUT).",
  };

  /** Leave the manager in the state a firewalled host leaves it in: the channel
   *  built, one host op attempted, one transport failure observed. */
  async function observeTransportFailure() {
    await expect(
      sshManager.withHostExecutor(async () => {
        throw handshakeTimeout();
      }),
    ).rejects.toThrow(/Timed out/);
  }

  it("costs nothing while the channel is healthy", async () => {
    // The gate must be free in the normal case, or every host op on every box pays a
    // TCP probe to protect the one box whose firewall is shut.
    const { hostChannelHealth } = await import("@repo/adapters");
    await sshManager.withHostExecutor(async () => true);
    await sshManager.withHostExecutor(async () => true);
    expect(hostChannelHealth).not.toHaveBeenCalled();
  });

  it("drops the pooled channel on a transport failure, so the gate can run at all", async () => {
    // Load-bearing: `acquireHostChannel`'s cache fast-path returns BEFORE the gate,
    // so a channel left cached is handed to every later op and the gate never gets a
    // say — exactly the failure-at-a-time behaviour it exists to end.
    await sshManager.withHostExecutor(async () => true);
    expect(pool().has(HOST_KEY)).toBe(true);
    await observeTransportFailure();
    expect(pool().has(HOST_KEY)).toBe(false);
  });

  it("refuses the next acquire with the remedy instead of another handshake timeout", async () => {
    const { hostChannelHealth, isHostChannelUnavailableError } = await import("@repo/adapters");
    await observeTransportFailure();

    vi.mocked(hostChannelHealth).mockResolvedValueOnce(BLOCKED);
    const err = await sshManager.withHostExecutor(async () => "never runs").catch((e) => e);

    expect(isHostChannelUnavailableError(err)).toBe(true);
    expect(err.code).toBe("unreachable");
    // Both halves travel with the refusal — this is the only place an operator sees them.
    expect(err.message).toContain(BLOCKED.hint);
    expect(err.message).toContain("sudo ufw allow from 172.18.0.0/16 to any port 22 proto tcp");
    // And no second executor was built to be timed out against.
    expect(h.created).toBe(1);
  });

  it("re-probes every time — a channel that came back is used on the very next call", async () => {
    // The version of this that shipped as a TTL cache kept answering "unavailable"
    // for a host whose firewall had already been fixed, which is a worse lie than
    // the one it replaced.
    const { hostChannelHealth } = await import("@repo/adapters");
    await observeTransportFailure();

    vi.mocked(hostChannelHealth).mockResolvedValueOnce({ ok: true, code: "ok" });
    await expect(sshManager.withHostExecutor(async () => "ok")).resolves.toBe("ok");
    expect(hostChannelHealth).toHaveBeenCalledTimes(1);
    expect(h.created).toBe(2);

    // …and the suspicion is cleared, not merely bypassed by the fresh cache entry:
    // reclaim the channel and the next acquire pays no probe.
    (sshManager as unknown as { dropServer: (k: string, f?: boolean) => void }).dropServer(
      HOST_KEY,
      true,
    );
    await expect(sshManager.withHostExecutor(async () => "ok")).resolves.toBe("ok");
    expect(hostChannelHealth).toHaveBeenCalledTimes(1);
  });

  it("does not blame the channel for a command that reached the host and failed", async () => {
    // A non-zero exit or a missing file dialed successfully. Marking the channel
    // suspect here would refuse host control over an `rm` of something already gone.
    const { hostChannelHealth } = await import("@repo/adapters");
    await sshManager.withHostExecutor(async () => true);
    await expect(
      sshManager.withHostExecutor(async () => {
        throw new Error("exit 2: /etc/nope: No such file or directory");
      }),
    ).rejects.toThrow(/No such file/);

    expect(pool().has(HOST_KEY)).toBe(true);
    await expect(sshManager.withHostExecutor(async () => "still fine")).resolves.toBe("still fine");
    expect(hostChannelHealth).not.toHaveBeenCalled();
    expect(h.created).toBe(1);
  });

  it("does not convert a deliberate opt-out into an unreachable channel", async () => {
    // `disabled` / `not_configured` are decided by env and a local file read, and
    // `createHostExecutor` raises them itself — fast, with their own remedy. The gate
    // pre-empts only the state that costs a timeout to discover.
    await observeTransportFailure();
    const { hostChannelHealth } = await import("@repo/adapters");
    vi.mocked(hostChannelHealth).mockResolvedValueOnce({ ok: false, code: "disabled" });
    await expect(sshManager.withHostExecutor(async () => "ok")).resolves.toBe("ok");
  });

  it("believes an operator who just fixed the firewall and hit retry", async () => {
    // `invalidate()` is that retry (and a settings save). A remembered failure must
    // not answer for a channel nobody has re-tested.
    const { hostChannelHealth } = await import("@repo/adapters");
    await observeTransportFailure();
    sshManager.invalidate();

    await expect(sshManager.withHostExecutor(async () => "ok")).resolves.toBe("ok");
    expect(hostChannelHealth).not.toHaveBeenCalled();
  });

  it("still builds exactly one executor when 8 callers hit the armed gate at once", async () => {
    // The gate awaits, and an await between the pending-check and the pending-set is
    // the window that orphaned 8,000+ sshd sessions (#291). It has to live INSIDE the
    // deduped promise, and a slow probe is what proves it does.
    const { hostChannelHealth } = await import("@repo/adapters");
    await observeTransportFailure();
    vi.mocked(hostChannelHealth).mockImplementationOnce(async () => {
      await new Promise((r) => setTimeout(r, 5));
      return { ok: true, code: "ok" };
    });

    const results = await Promise.all(
      Array.from({ length: 8 }, () => sshManager.withHostExecutor(async (exec) => exec)),
    );
    expect(hostChannelHealth).toHaveBeenCalledTimes(1);
    expect(h.created).toBe(2); // the pre-gate one, plus one for all 8 callers
    expect(new Set(results).size).toBe(1);
  });

  it("arms from a LOCAL ROW's failure too — the row IS the channel", async () => {
    // A deploy to "This Server" runs host steps through the row id, not the channel
    // key. If only `withHostExecutor` armed the gate, the most common way to discover
    // a blocked channel would be the one way that never recorded it.
    const { hostChannelHealth, isHostChannelUnavailableError } = await import("@repo/adapters");
    await sshManager.acquire("local-1");
    await expect(
      sshManager.withExecutor("local-1", async () => {
        throw handshakeTimeout();
      }),
    ).rejects.toThrow(/Timed out/);

    vi.mocked(hostChannelHealth).mockResolvedValueOnce(BLOCKED);
    const err = await sshManager.withHostExecutor(async () => "never runs").catch((e) => e);
    expect(isHostChannelUnavailableError(err)).toBe(true);
    expect(err.message).toContain("sudo ufw allow from");
  });

  it("keeps the breaker and the gate reading the same evidence", async () => {
    // A transport failure that survives a retry on a FRESH connection used to escape
    // both: the retry threw from inside the outer catch, past `recordFailure`. So a
    // firewalled channel failed indefinitely, two handshake timeouts at a time.
    await sshManager.acquire("local-1");
    await expect(
      sshManager.withExecutor("local-1", async () => {
        throw handshakeTimeout();
      }),
    ).rejects.toThrow(/Timed out/);

    const health = (sshManager as unknown as { health: Map<string, { fails: number }> }).health;
    expect(health.get("local-1")?.fails).toBe(1);
  });
});
