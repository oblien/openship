import { beforeEach, expect, it, vi } from "vitest";
import type { ExecutionContext } from "@repo/platform";
import { subscriptionEvents } from "../../../../../packages/platform/src/event-stream";
import { serviceDependencies } from "@repo/platform/engine/modules/services/service.operations";

const h = vi.hoisted(() => ({ stream: vi.fn(), cleanup: vi.fn(), retain: vi.fn(), release: vi.fn() }));
vi.mock("@repo/platform/engine/modules/services/service.service", () => ({ streamServiceRuntimeLogs: h.stream }));
vi.mock("@repo/platform/engine/lib/ssh-manager", () => ({ sshManager: { retain: h.retain, release: h.release } }));
const ctx = { userId: "user", organizationId: "org" } as ExecutionContext;
beforeEach(() => { vi.clearAllMocks(); });

it("yields one terminal event before cleaning up the runtime and SSH lease", async () => {
  h.stream.mockImplementation(async (_ctx, _project, _service, onLog, opts) => {
    onLog({ message: "ready", timestamp: "now", level: "info" });
    opts.onEnd();
    opts.onEnd();
    return { cleanup: h.cleanup, serverId: "server" };
  });
  const stream = subscriptionEvents(serviceDependencies.subscribe(ctx, "project", "service", { tail: 10, deploymentId: "deployment" }));
  expect((await stream.next()).value?.event).toBe("log");
  expect((await stream.next()).value).toMatchObject({ event: "end", data: JSON.stringify({ message: "Log stream ended" }) });
  expect(h.cleanup).not.toHaveBeenCalled();
  expect((await stream.next()).done).toBe(true);
  expect(h.cleanup).toHaveBeenCalledOnce();
  expect(h.retain).toHaveBeenCalledWith("server");
  expect(h.release).toHaveBeenCalledWith("server");
  expect(h.stream.mock.calls[0]![4]).toMatchObject({ tail: 10, deploymentId: "deployment" });
});

it("preserves transport failure instead of claiming a clean container exit", async () => {
  h.stream.mockImplementation(async (_ctx, _project, _service, _onLog, opts) => {
    opts.onEnd(new Error("SSH log connection dropped"));
    return { cleanup: h.cleanup, serverId: null };
  });
  const events = [];
  for await (const event of subscriptionEvents(serviceDependencies.subscribe(ctx, "project", "service", {}))) events.push(event);
  expect(events).toEqual([{ event: "end", data: JSON.stringify({ error: "SSH log connection dropped" }) }]);
  expect(h.cleanup).toHaveBeenCalledOnce();
  expect(h.retain).not.toHaveBeenCalled();
  expect(h.release).not.toHaveBeenCalled();
});

it("releases a subscription which finishes opening after its client aborts", async () => {
  let started!: () => void;
  const opening = new Promise<void>(resolve => { started = resolve; });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  h.stream.mockImplementation(async () => {
    started();
    await gate;
    return { cleanup: h.cleanup, serverId: "server" };
  });
  const abort = new AbortController();
  const stream = subscriptionEvents(serviceDependencies.subscribe(ctx, "project", "service", {}), abort.signal);
  const reading = stream.next();
  await opening;
  abort.abort();
  release();
  await expect(reading).rejects.toMatchObject({ name: "AbortError" });
  expect(h.cleanup).toHaveBeenCalledOnce();
  expect(h.release).toHaveBeenCalledOnce();
});
