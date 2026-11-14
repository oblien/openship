import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { SSEStreamingApi } from "hono/streaming";
import { closeControllerStreams, resumeControllerStreams, streamSSE } from "../../src/lib/sse";
import { drainBackgroundWork } from "@repo/platform/engine/lib/background-work";

beforeEach(() => resumeControllerStreams());
afterEach(async () => {
  closeControllerStreams();
  await drainBackgroundWork();
  resumeControllerStreams();
});

it("refuses a stream admitted before the move but initialized after streams were closed", async () => {
  let enter!: () => void;
  let proceed!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const admitted = new Promise<void>(resolve => { proceed = resolve; });
  const callback = vi.fn(async (stream: SSEStreamingApi) => {
    await new Promise<void>(resolve => stream.onAbort(resolve));
  });
  const app = new Hono();
  app.get("/events", async c => {
    enter();
    await admitted; // permission/metadata read already admitted by the HTTP guard
    return streamSSE(c, callback);
  });
  const pending = app.request("/events");
  await entered;
  closeControllerStreams();
  proceed();
  const response = await pending;
  try {
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "INSTANCE_CONTROLLER_INACTIVE" });
    expect(callback).not.toHaveBeenCalled();
  } finally {
    closeControllerStreams();
    if (!response.bodyUsed) await response.body?.cancel();
    await drainBackgroundWork();
  }
});

it("aborts an existing subscriber so the controller can finish draining", async () => {
  const aborted = vi.fn();
  const app = new Hono();
  app.get("/events", c => streamSSE(c, async stream => {
    await new Promise<void>(resolve => stream.onAbort(() => { aborted(); resolve(); }));
  }));
  const response = await app.request("/events");
  expect(response.status).toBe(200);
  closeControllerStreams();
  await drainBackgroundWork();
  expect(aborted).toHaveBeenCalledOnce();
  await response.body?.cancel();
});

it("accepts streams again when the active controller is resumed after cancellation", async () => {
  const callback = vi.fn(async () => {});
  const app = new Hono();
  app.get("/events", c => streamSSE(c, callback));
  closeControllerStreams();
  const refused = await app.request("/events");
  expect(refused.status).toBe(503);
  expect(callback).not.toHaveBeenCalled();
  resumeControllerStreams();
  const response = await app.request("/events");
  expect(response.status).toBe(200);
  expect(callback).toHaveBeenCalledOnce();
  await response.body?.cancel();
});
