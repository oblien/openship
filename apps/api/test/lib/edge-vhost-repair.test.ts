import { describe, it, expect, vi, afterEach } from "vitest";

import { repairEdgeVhosts } from "../../src/lib/edge-vhost-repair";

type Routing = Parameters<typeof repairEdgeVhosts>[0];
type Sweep = Awaited<ReturnType<NonNullable<NonNullable<Routing>["reapplyStoredRoutes"]>>>;

/** A routing provider that keeps config on disk, answering the sweep however a test wants. */
function sweeper(answer: Sweep | (() => never)): Routing {
  return {
    reapplyStoredRoutes: async () => (typeof answer === "function" ? answer() : answer),
  } as unknown as Routing;
}

/** Cloud and desktop: no generated config on disk, so no `reapplyStoredRoutes` at all. */
const NO_EDGE = {} as unknown as Routing;

const CONVERGED: Sweep = { scanned: 3, repaired: [], failed: [] };

describe("repairEdgeVhosts", () => {
  afterEach(() => vi.restoreAllMocks());

  it("treats a provider with nothing on disk as not-applicable, not as a failure", async () => {
    // Cloud routes through Oblien's API and desktop has no edge. Reporting a `failed` entry
    // here would put a routing warning on every cloud deploy for a sweep that is
    // meaningless there — and this runs on the deploy path, where a warning nobody can act
    // on is how operators learn to skip the ones they can.
    const onLog = vi.fn();
    expect(await repairEdgeVhosts(NO_EDGE, { onLog })).toEqual({
      scanned: 0,
      repaired: [],
      failed: [],
    });
    expect(await repairEdgeVhosts(null)).toEqual({ scanned: 0, repaired: [], failed: [] });
    expect(await repairEdgeVhosts(undefined)).toEqual({ scanned: 0, repaired: [], failed: [] });
    expect(onLog).not.toHaveBeenCalled();
  });

  it("says nothing at all on a converged box", async () => {
    // The steady state, and it must be silent. Every deploy on every box runs this; a line
    // per deploy saying "nothing to do" is noise that trains operators past the one time it
    // says otherwise. `scanned` still reports the truth for a caller that wants it.
    const onLog = vi.fn();
    expect(await repairEdgeVhosts(sweeper(CONVERGED), { onLog })).toEqual(CONVERGED);
    expect(onLog).not.toHaveBeenCalled();
  });

  it("names the routes it brought up to date", async () => {
    const onLog = vi.fn();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await repairEdgeVhosts(
      sweeper({ scanned: 4, repaired: ["a.opsh.io", "b.example.com"], failed: [] }),
      { onLog },
    );
    expect(onLog).toHaveBeenCalledTimes(1);
    const [message, level] = onLog.mock.calls[0]!;
    expect(message).toContain("a.opsh.io");
    expect(message).toContain("b.example.com");
    // Deploy-log lines are written raw onto a stream, so the newline is part of the payload.
    expect(message.endsWith("\n")).toBe(true);
    // Work that succeeded is not a warning.
    expect(level).toBeUndefined();
    expect(log).toHaveBeenCalled();
  });

  it("reports a per-route failure as a warning and still returns the successes", async () => {
    // One route whose sidecar is unreadable must not hide the ones that converged: a
    // half-repaired edge that says so is strictly better than a silent one.
    const onLog = vi.fn();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await repairEdgeVhosts(
      sweeper({
        scanned: 2,
        repaired: ["ok.opsh.io"],
        failed: [{ slug: "broken", reason: "sidecar has no domain" }],
      }),
      { onLog },
    );
    expect(result.repaired).toEqual(["ok.opsh.io"]);
    const warned = onLog.mock.calls.filter(([, level]) => level === "warn");
    expect(warned).toHaveLength(1);
    expect(warned[0]![0]).toContain("broken");
    expect(warned[0]![0]).toContain("sidecar has no domain");
  });

  it("never throws when the whole sweep fails", async () => {
    // The contract the two call sites depend on. `build-pipeline` runs this inside the
    // edge/routing block and `ensure-edge` inside a fire-and-forget — routing failures
    // never fail a deploy, so a wedged edge box must come back as a reported failure
    // rather than an exception that skips the steps after it.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await repairEdgeVhosts(
      sweeper(() => {
        throw new Error("edge unreachable");
      }),
    );
    expect(result).toEqual({
      scanned: 0,
      repaired: [],
      failed: [{ slug: "*", reason: "edge unreachable" }],
    });
    expect(String(warn.mock.calls[0]?.[0])).toContain("edge unreachable");
  });
});
