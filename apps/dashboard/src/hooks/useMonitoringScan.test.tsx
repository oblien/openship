// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { monitoringScanIncomplete, useMonitoringScan } from "./useMonitoringScan";
import type { MonitoringScanSession } from "@/lib/api/issues";

const h = vi.hoisted(() => ({ status: vi.fn(), start: vi.fn(), complete: vi.fn(), organizationId: "org-1" }));
vi.mock("@/lib/api", () => ({
  issuesApi: { rescanStatus: h.status, rescan: h.start },
  getApiErrorMessage: (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback,
}));
vi.mock("@/lib/api/client", () => ({ getActiveOrganizationId: () => h.organizationId }));

function session(status: "running" | "completed", id = "scan-1"): MonitoringScanSession {
  return {
    id, status, startedAt: "2026-09-26T00:00:00Z",
    stages: [{ key: "services:health-watch", status: status === "running" ? "running" : "completed", summary: { servers: 1, unreachable: 0 } }],
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

let root: Root;
let container: HTMLDivElement;
let result: ReturnType<typeof useMonitoringScan>;
let options: { enabled: boolean; online: boolean; recheckOnReconnect: boolean };
function Harness() {
  result = useMonitoringScan({ ...options, onComplete: h.complete });
  return <button disabled={!result.canRescan || result.rescanning} onClick={result.rescan}>Recheck</button>;
}
async function render(changes: Partial<typeof options> = {}) {
  Object.assign(options, changes);
  await act(async () => root.render(<Harness />));
}
async function advance(ms = 1200) {
  await act(async () => vi.advanceTimersByTimeAsync(ms));
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  h.organizationId = "org-1";
  h.status.mockReset().mockResolvedValue({ data: null });
  h.start.mockReset().mockResolvedValue({ data: session("running") });
  h.complete.mockReset().mockResolvedValue(undefined);
  options = { enabled: true, online: true, recheckOnReconnect: true };
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("monitoring scan admission and recovery", () => {
  it("admits one request for repeated clicks and refreshes once after completion", async () => {
    await render();
    await act(async () => { for (let n = 0; n < 10; n++) result.rescan(); });
    expect(h.start).toHaveBeenCalledOnce();
    expect(h.start).toHaveBeenLastCalledWith({ healthOnly: false });
    expect(result.rescanning).toBe(true);
    expect(container.querySelector("button")!.disabled).toBe(true);

    h.status.mockResolvedValue({ data: session("completed") });
    await advance();
    expect(result.rescanning).toBe(false);
    expect(h.complete).toHaveBeenCalledExactlyOnceWith(session("completed"), true);
    await advance(60_000);
    expect(h.status).toHaveBeenCalledTimes(2);
  });

  it("recovers from a failed status read instead of leaving Scanning stuck", async () => {
    await render();
    await act(async () => result.rescan());
    h.status.mockRejectedValueOnce(new Error("Network request timed out"));
    await advance();
    expect(result.error).toBe("Network request timed out");
    expect(result.rescanning).toBe(true);

    h.status.mockResolvedValue({ data: session("completed") });
    await advance();
    expect(result.error).toBeNull();
    expect(result.rescanning).toBe(false);
    expect(h.complete).toHaveBeenCalledOnce();
    expect(h.start).toHaveBeenCalledOnce();
  });

  it("reattaches to a POST with a lost response before allowing another run", async () => {
    h.start.mockRejectedValueOnce(new Error("Response timed out"));
    await render();
    await act(async () => result.rescan());
    expect(result.canRescan).toBe(false);
    await act(async () => result.rescan());
    expect(h.start).toHaveBeenCalledOnce();

    h.status.mockResolvedValue({ data: session("running") });
    await advance();
    expect(result.rescanning).toBe(true);
    h.status.mockResolvedValue({ data: session("completed") });
    await advance();
    expect(h.complete).toHaveBeenCalledOnce();
    expect(h.start).toHaveBeenCalledOnce();
  });

  it.each([
    ["no previous scan", null],
    ["a previous completed scan", session("completed", "old-scan")],
  ] as const)("refreshes once when a lost start response recovers directly to completion with %s", async (_, previous) => {
    h.status.mockResolvedValue({ data: previous });
    await render();
    h.start.mockRejectedValueOnce(new Error("Response timed out"));
    await act(async () => result.rescan());

    h.status.mockResolvedValue({ data: session("completed", "new-scan") });
    await advance();
    expect(result.rescanning).toBe(false);
    expect(result.scan?.id).toBe("new-scan");
    expect(h.complete).toHaveBeenCalledExactlyOnceWith(session("completed", "new-scan"), true);
    await act(async () => window.dispatchEvent(new Event("focus")));
    await advance(60_000);
    expect(h.complete).toHaveBeenCalledOnce();
    expect(h.start).toHaveBeenCalledOnce();
  });

  it.each([
    ["no scan", null],
    ["the previous completed scan", session("completed", "old-scan")],
  ] as const)(
    "does not report completion when recovery finds %s",
    async (_, previous) => {
      h.status.mockResolvedValue({ data: previous });
      await render();
      h.start.mockRejectedValueOnce(new Error("Response timed out"));
      await act(async () => result.rescan());
      await advance();
      expect(result.canRescan).toBe(true);
      expect(h.complete).not.toHaveBeenCalled();

      // A later scan from another reader must not inherit the failed request's notification.
      h.status.mockResolvedValue({ data: session("running", "external-scan") });
      await act(async () => result.refresh());
      h.status.mockResolvedValue({ data: session("completed", "external-scan") });
      await advance();
      expect(h.complete).toHaveBeenCalledExactlyOnceWith(session("completed", "external-scan"), false);
      expect(h.start).toHaveBeenCalledOnce();
    },
  );

  it("handles an immediately completed admission once", async () => {
    h.start.mockResolvedValue({ data: session("completed") });
    await render();
    await act(async () => result.rescan());
    h.status.mockResolvedValue({ data: session("completed") });
    await act(async () => result.refresh());
    expect(result.rescanning).toBe(false);
    expect(h.complete).toHaveBeenCalledExactlyOnceWith(session("completed"), true);
    expect(h.start).toHaveBeenCalledOnce();
  });

  it("preserves a pending admission across reconnect and ignores its late response", async () => {
    await render({ recheckOnReconnect: false });
    const admission = deferred<{ data: MonitoringScanSession }>();
    h.start.mockReturnValueOnce(admission.promise);
    await act(async () => result.rescan());
    await render({ online: false });
    h.status.mockResolvedValue({ data: session("completed") });
    await render({ online: true });
    await act(async () => admission.resolve({ data: session("completed") }));
    await act(async () => result.refresh());
    expect(result.rescanning).toBe(false);
    expect(h.complete).toHaveBeenCalledExactlyOnceWith(session("completed"), true);
    expect(h.start).toHaveBeenCalledOnce();
  });

  it("does not carry a lost admission into a different organization", async () => {
    await render();
    h.start.mockRejectedValueOnce(new Error("Response timed out"));
    await act(async () => result.rescan());
    h.organizationId = "org-2";
    h.status.mockResolvedValue({ data: session("completed", "other-scan") });
    await advance();
    expect(h.complete).not.toHaveBeenCalled();
    expect(h.start).toHaveBeenCalledOnce();
  });

  it("checks once after desktop reconnect, without repeating POSTs on focus or rerender", async () => {
    await render({ online: false });
    expect(h.status).not.toHaveBeenCalled();
    await render({ online: true });
    expect(h.start).toHaveBeenCalledOnce();
    expect(h.start).toHaveBeenLastCalledWith({ healthOnly: true });
    h.status.mockResolvedValue({ data: session("completed") });
    await advance();
    expect(h.complete).toHaveBeenCalledExactlyOnceWith(session("completed"), false);
    await render();
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(h.start).toHaveBeenCalledOnce();
  });

  it("queues one fresh check when reconnecting during an older scan", async () => {
    h.status.mockResolvedValue({ data: session("running", "old") });
    await render();
    await render({ online: false });
    await render({ online: true });
    expect(h.start).not.toHaveBeenCalled();
    h.status.mockResolvedValue({ data: session("completed", "old") });
    await advance();
    expect(h.start).toHaveBeenCalledOnce();
    expect(result.scan?.id).toBe("scan-1");
    expect(result.rescanning).toBe(true);
    h.status.mockResolvedValue({ data: session("completed") });
    await advance();
    await advance(60_000);
    expect(h.start).toHaveBeenCalledOnce();
    expect(h.complete).toHaveBeenCalledTimes(2);
  });

  it("does not launch instance jobs just because a remote browser reconnects", async () => {
    await render({ online: false, recheckOnReconnect: false });
    await render({ online: true });
    expect(h.status).toHaveBeenCalledOnce();
    expect(h.start).not.toHaveBeenCalled();
  });

  it("keeps polling when an older status request outlasts a newly accepted scan's timer", async () => {
    await render();
    const oldRead = deferred<{ data: MonitoringScanSession }>();
    h.status.mockReturnValueOnce(oldRead.promise);
    await act(async () => window.dispatchEvent(new Event("focus")));
    await act(async () => result.rescan());
    await advance(2400);
    await act(async () => oldRead.resolve({ data: session("completed", "old") }));
    expect(result.scan?.id).toBe("scan-1");
    expect(result.rescanning).toBe(true);
    expect(h.complete).not.toHaveBeenCalled();

    h.status.mockResolvedValue({ data: session("completed") });
    await advance();
    expect(result.rescanning).toBe(false);
    expect(h.complete).toHaveBeenCalledExactlyOnceWith(session("completed"), true);
    expect(h.start).toHaveBeenCalledOnce();
  });

  it("reattaches after a lost POST response even when an older GET consumed its retry timer", async () => {
    await render();
    const oldRead = deferred<{ data: null }>();
    h.status.mockReturnValueOnce(oldRead.promise);
    await act(async () => window.dispatchEvent(new Event("focus")));
    h.start.mockRejectedValueOnce(new Error("Response timed out"));
    await act(async () => result.rescan());
    await advance(2400);
    await act(async () => oldRead.resolve({ data: null }));
    expect(result.canRescan).toBe(false);

    h.status.mockResolvedValue({ data: session("running") });
    await advance();
    expect(result.rescanning).toBe(true);
    h.status.mockResolvedValue({ data: session("completed") });
    await advance();
    expect(result.rescanning).toBe(false);
    expect(h.complete).toHaveBeenCalledExactlyOnceWith(session("completed"), true);
    expect(h.start).toHaveBeenCalledOnce();
  });

  it("stops readers on unmount without cancelling the server scan or publishing late results", async () => {
    await render();
    const admission = deferred<{ data: MonitoringScanSession }>();
    h.start.mockReturnValue(admission.promise);
    await act(async () => result.rescan());
    await act(async () => root.unmount());
    root = createRoot(container);
    await act(async () => admission.resolve({ data: session("completed") }));
    await advance(60_000);
    expect(h.status).toHaveBeenCalledOnce();
    expect(h.complete).not.toHaveBeenCalled();
  });

  it("does not publish a scan result in a different organization", async () => {
    await render();
    const admission = deferred<{ data: MonitoringScanSession }>();
    h.start.mockReturnValue(admission.promise);
    await act(async () => result.rescan());
    h.organizationId = "org-2";
    await act(async () => admission.resolve({ data: session("completed") }));
    expect(h.complete).not.toHaveBeenCalled();
    expect(result.scan).toBeNull();
  });

  it("disables instance scans when the caller cannot read their status", async () => {
    h.status.mockRejectedValue({ status: 403 });
    await render();
    await act(async () => result.rescan());
    expect(result.canRescan).toBe(false);
    expect(h.start).not.toHaveBeenCalled();
    await advance(60_000);
    expect(h.status).toHaveBeenCalledOnce();
  });

  it("never asks the local-only endpoint in cloud mode", async () => {
    await render({ enabled: false });
    await act(async () => result.rescan());
    expect(h.status).not.toHaveBeenCalled();
    expect(h.start).not.toHaveBeenCalled();
  });

  it("uses only the health checker for an unreachable-server retry", async () => {
    await render();
    await act(async () => result.recheckHealth());
    expect(h.start).toHaveBeenCalledExactlyOnceWith({ healthOnly: true });
  });
});

it.each(["offline", "unreachable", "errors", "unresolved", "indeterminate", "skipped"])(
  "keeps a completed checker with %s coverage out of the all-clear state",
  (counter) => {
    expect(monitoringScanIncomplete({ key: "services:health-watch", status: "completed", summary: { [counter]: 1 } })).toBe(true);
    expect(monitoringScanIncomplete({ key: "services:health-watch", status: "completed", summary: { [counter]: 0 } })).toBe(false);
  },
);
