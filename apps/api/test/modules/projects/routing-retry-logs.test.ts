import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecutionContext } from "@repo/platform";

const h = vi.hoisted(() => ({
  retry: vi.fn(),
  work: undefined as Promise<void> | undefined,
}));
vi.mock("@repo/platform/engine/modules/projects/project-runtime.service", () => ({
  retryProjectRouting: h.retry,
}));
vi.mock("@repo/platform/engine/lib/self-app-routing", () => ({
  canRouteSelfApp: async () => false,
}));
vi.mock("@repo/platform/engine/modules/domains/domain.operations", () => ({
  verifyProjectRoutingDomains: vi.fn(),
}));
vi.mock("@repo/platform/engine/lib/audit-emitter", () => ({
  audit: { recordAsync: vi.fn() },
  operationAuditContext: (ctx: unknown) => ctx,
}));
vi.mock("@repo/platform/engine/lib/background-work", () => ({
  trackBackgroundWork: (work: Promise<void>) => {
    h.work = work;
    return work;
  },
}));

import {
  getProjectRoutingRetry,
  retryProjectRoutingOperation,
  subscribeRoutingRetry,
} from "@repo/platform/engine/modules/projects/project-routing-retry.operations";

let projectId: string;
let sequence = 0;
const context = { organizationId: "org-a" } as ExecutionContext;
function watch(ctx = context, id = projectId, sessionId?: string, idempotencyKey?: string) {
  const events: Array<{
    event: string;
    data: { type: string; message?: string; sessionId?: string; status?: string };
  }> = [];
  const subscription = subscribeRoutingRetry(ctx, id, { sessionId, idempotencyKey })((
    event,
    data,
  ) => {
    events.push({ event, data: JSON.parse(data) });
    return true;
  });
  return { events, subscription };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.work = undefined;
  projectId = `project-${++sequence}`;
});
afterEach(() => vi.useRealTimers());

describe("routing retry log outcome", () => {
  it.each([false, true])(
    "reports each failed hostname once and retains the failed outcome (logged during work: %s)",
    async (alreadyLogged) => {
      const warnings = [
        "api.example.com: server is unreachable",
        "app.example.com: target is unavailable",
      ];
      h.retry.mockImplementation(async (_id, _org, opts) => {
        opts.onLog("Applying the project's current routes…");
        if (alreadyLogged) for (const warning of warnings) opts.onLog(warning);
        opts.onLog("Synchronizing managed domains…");
        return { ok: false, warning: warnings.join("\n") };
      });
      const events: Array<{ event: string; data: { message?: string; status?: string } }> = [];
      subscribeRoutingRetry(
        { organizationId: "org-a" } as ExecutionContext,
        projectId,
      )((event, data) => {
        events.push({ event, data: JSON.parse(data) });
        return true;
      });
      await h.work;

      const lines = events
        .filter(({ event }) => event === "log")
        .flatMap(({ data }) => data.message?.split("\n") ?? []);
      for (const warning of warnings)
        expect(lines.filter((line) => line === warning)).toHaveLength(1);
      expect(events.at(-1)).toEqual({
        event: "complete",
        data: { type: "complete", status: "failed" },
      });
    },
  );

  it("joins concurrent JSON/stream retries and replays the same logs after a browser disconnect", async () => {
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    h.retry.mockImplementation(async (_id, _org, opts) => {
      opts.onLog("Applying the route");
      await gate;
      opts.onLog("Existing certificate verified");
      return { ok: true };
    });
    const first = watch();
    await vi.waitFor(() => expect(h.retry).toHaveBeenCalledOnce());
    const sessionId = first.events[0].data.sessionId!;
    (await first.subscription).unsubscribe();
    const json = retryProjectRoutingOperation(context, projectId);
    const second = watch(context, projectId, undefined, "second-viewer");
    const resumed = watch(context, projectId, sessionId);
    expect(second.events[0].data.sessionId).toBe(sessionId);
    expect(resumed.events.some(({ data }) => data.message === "Applying the route")).toBe(true);
    expect(getProjectRoutingRetry("org-a", projectId)?.status).toBe("running");
    finish();
    await expect(json).resolves.toEqual({ ok: true });
    expect(h.retry).toHaveBeenCalledOnce();
    expect(first.events.some(({ data }) => data.message === "Existing certificate verified")).toBe(
      false,
    );
    expect(resumed.events.at(-1)?.data.status).toBe("completed");
    expect(getProjectRoutingRetry("org-a", projectId)?.status).toBe("completed");
    const completed = watch(context, projectId, sessionId);
    expect(completed.events).toEqual(resumed.events);
    expect(watch(context, projectId, undefined, "second-viewer").events).toEqual(resumed.events);
    expect(h.retry).toHaveBeenCalledOnce();
  });

  it("replays an already completed start request while allowing a new explicit repair", async () => {
    h.retry.mockResolvedValue({ ok: true });
    const first = watch(context, projectId, undefined, "first-click");
    await h.work;
    expect(watch(context, projectId, undefined, "first-click").events).toEqual(first.events);
    expect(h.retry).toHaveBeenCalledOnce();
    const next = watch(context, projectId, undefined, "next-click");
    await h.work;
    expect(next.events[0].data.sessionId).not.toBe(first.events[0].data.sessionId);
    expect(h.retry).toHaveBeenCalledTimes(2);
    // Repeating the first request must not read the newer operation's outcome.
    expect(watch(context, projectId, undefined, "first-click").events).toEqual(first.events);
  });

  it("keeps a thrown failure replayable and hides the log from other projects or organizations", async () => {
    h.retry.mockRejectedValue(new Error("SSH connection refused"));
    const first = watch();
    await expect(h.work).rejects.toThrow("SSH connection refused");
    const sessionId = first.events[0].data.sessionId!;
    expect(getProjectRoutingRetry("org-a", projectId)?.status).toBe("failed");
    expect(watch(context, projectId, sessionId).events).toEqual(first.events);
    for (const [ctx, id] of [
      [{ organizationId: "org-b" }, projectId],
      [context, "other-project"],
    ] as const) {
      expect(() => watch(ctx as ExecutionContext, id, sessionId)).toThrow("no longer available");
      expect(getProjectRoutingRetry(ctx.organizationId, id)).toBeNull();
    }
    expect(h.retry).toHaveBeenCalledOnce();
  });

  it("never expires active work and expires completed logs without starting a replacement", async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    h.retry.mockImplementation(async () => {
      await gate;
      return { ok: true };
    });
    const first = watch();
    const sessionId = first.events[0].data.sessionId!;
    await vi.advanceTimersByTimeAsync(31 * 60_000);
    expect(watch().events[0].data.sessionId).toBe(sessionId);
    finish();
    await h.work;
    expect(watch(context, projectId, sessionId).events.at(-1)?.data.status).toBe("completed");
    await vi.advanceTimersByTimeAsync(31 * 60_000);
    expect(getProjectRoutingRetry("org-a", projectId)).toBeNull();
    expect(() => watch(context, projectId, sessionId)).toThrow("no longer available");
    expect(h.retry).toHaveBeenCalledOnce();
  });

  it("bounds retained output while preserving the final failure and recent logs", async () => {
    h.retry.mockImplementation(async (_id, _org, opts) => {
      for (let i = 0; i < 1_500; i++) opts.onLog(`${i}: ${"x".repeat(2_000)}`);
      return { ok: false, warning: "Route activation failed" };
    });
    const first = watch();
    await h.work;
    const retained = watch(context, projectId, first.events[0].data.sessionId!).events;
    const logs = retained.filter(({ event }) => event === "log");
    expect(logs.length).toBeLessThanOrEqual(500);
    expect(
      logs.reduce((size, { data }) => size + (data.message?.length ?? 0), 0),
    ).toBeLessThanOrEqual(512 * 1024);
    expect(logs.at(-1)?.data.message).toBe("Route activation failed");
    expect(retained.at(-1)?.data.status).toBe("failed");
  });
});
