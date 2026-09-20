import { describe, expect, it } from "vitest";
import {
  groupServerWorkloads,
  serverDestroyBlockedReason,
  serverRemovalSummary,
  serverRemovalTimeoutMs,
  type ServerWorkloadPreview,
} from "./server-removal";

/**
 * The four decisions behind "Remove server", none of them reachable from the modal.
 *
 * They are separated because each one has a wrong answer that ships silently: a fixed
 * timeout that aborts a removal the server completes, a destroy checkbox offered for a
 * box that cannot answer, a confirm list that promises to remove the control plane, and
 * a toast that reports the request instead of the response.
 */

const w = (over: Partial<ServerWorkloadPreview> = {}): ServerWorkloadPreview => ({
  id: "p1",
  name: "p1",
  slug: "p1",
  environmentName: "Production",
  environmentSlug: "production",
  groupName: null,
  isApp: false,
  isControlPlane: false,
  activeDeploymentId: "dep1",
  ...over,
});

describe("serverRemovalTimeoutMs", () => {
  it("stays at the base for a control-plane-only removal", () => {
    // Record-only is DB work: no SSH round trip to wait on.
    expect(serverRemovalTimeoutMs({ workloadCount: 12 })).toBe(60_000);
    expect(serverRemovalTimeoutMs({ destroyOnSource: false, workloadCount: 12 })).toBe(60_000);
  });

  it("scales with the workload count when destroying on the source", () => {
    const one = serverRemovalTimeoutMs({ destroyOnSource: true, workloadCount: 1 });
    const four = serverRemovalTimeoutMs({ destroyOnSource: true, workloadCount: 4 });
    expect(four).toBeGreaterThan(one);
    // A fixed timeout is the defect: the fetch aborts, the server finishes the
    // teardown anyway, and the operator is shown a failure over a success.
    expect(four).toBeGreaterThan(60_000);
  });

  it("caps rather than spinning for an hour on a big fleet", () => {
    expect(serverRemovalTimeoutMs({ destroyOnSource: true, workloadCount: 500 })).toBe(15 * 60_000);
  });

  it("survives a missing count", () => {
    expect(serverRemovalTimeoutMs({ destroyOnSource: true })).toBe(60_000);
  });
});

describe("serverDestroyBlockedReason", () => {
  it("offers the destroy option only for a box that answered", () => {
    expect(serverDestroyBlockedReason({ reachable: true })).toBeNull();
  });

  it("blocks on an unreachable box", () => {
    // Asking a dead host to stop containers orphans every resource for GC — and GC
    // resolves its transport from the server row this action deletes.
    expect(serverDestroyBlockedReason({ reachable: false })).toBe("unreachable");
  });

  it("treats an undetermined probe as blocking, not as reachable", () => {
    // `null` is "we could not tell". Falling through to offerable would be the
    // failure-open direction on the destructive path.
    expect(serverDestroyBlockedReason({ reachable: null })).toBe("unknown");
    expect(serverDestroyBlockedReason(null)).toBe("unknown");
  });
});

describe("groupServerWorkloads", () => {
  it("splits projects from apps", () => {
    const g = groupServerWorkloads([w({ id: "a" }), w({ id: "b", isApp: true })]);
    expect(g.projects.map((x) => x.id)).toEqual(["a"]);
    expect(g.apps.map((x) => x.id)).toEqual(["b"]);
  });

  it("keeps the control plane out of both removal lists", () => {
    const g = groupServerWorkloads([w({ id: "a" }), w({ id: "os", isControlPlane: true })]);
    // Listing it under "will be removed" would promise something the API refuses.
    expect(g.projects.map((x) => x.id)).toEqual(["a"]);
    expect(g.apps).toHaveLength(0);
    expect(g.staying.map((x) => x.id)).toEqual(["os"]);
  });

  it("classifies a control-plane row as staying even when it is an app", () => {
    const g = groupServerWorkloads([w({ id: "os", isApp: true, isControlPlane: true })]);
    expect(g.apps).toHaveLength(0);
    expect(g.staying).toHaveLength(1);
  });
});

describe("serverRemovalSummary", () => {
  it("reports the destroy from the RESPONSE, not from the request", () => {
    const s = serverRemovalSummary({
      ok: true,
      serverRemoved: true,
      destroyOnSource: false,
      workloads: [{ id: "a", name: "a", ok: true }],
      removed: 1,
    });
    expect(s).toEqual({ kind: "removed", count: 1, destroyed: false });
  });

  it("says destroyed only when the server says so", () => {
    const s = serverRemovalSummary({
      ok: true,
      serverRemoved: true,
      destroyOnSource: true,
      workloads: [{ id: "a", name: "a", ok: true }],
      removed: 1,
    });
    expect(s).toMatchObject({ kind: "removed", destroyed: true });
  });

  it("is partial when the server was kept, listing what needs attention", () => {
    const s = serverRemovalSummary({
      ok: false,
      code: "SERVER_WORKLOAD_TEARDOWN_FAILED",
      serverRemoved: false,
      destroyOnSource: true,
      workloads: [
        { id: "a", name: "a", ok: true },
        { id: "b", name: "b", ok: false, error: "still running" },
      ],
    });
    expect(s.kind).toBe("partial");
    expect(s.kind === "partial" && s.failed.map((f) => f.id)).toEqual(["b"]);
  });

  it("counts a workload that left an orphan as needing attention", () => {
    const s = serverRemovalSummary({
      ok: false,
      serverRemoved: false,
      destroyOnSource: true,
      // `ok: true` with a recorded orphan still blocked the removal server-side; a
      // summary that filtered on `ok` alone would show the operator an empty list.
      workloads: [{ id: "a", name: "a", ok: true, orphaned: 2 }],
    });
    expect(s.kind === "partial" && s.failed.map((f) => f.id)).toEqual(["a"]);
  });

  it("falls back to the workload count when `removed` is absent", () => {
    const s = serverRemovalSummary({
      ok: true,
      serverRemoved: true,
      destroyOnSource: false,
      workloads: [
        { id: "a", name: "a", ok: true },
        { id: "b", name: "b", ok: true },
      ],
    });
    expect(s).toMatchObject({ kind: "removed", count: 2 });
  });
});
