// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useMonitorStream } from "./useMonitorStream";

const scope = vi.hoisted(() => ({ value: "account-a:org-a" }));
vi.mock("@/context/CloudResourceContext", () => ({ useCloudResourceKey: () => scope.value }));
const fetcher = vi.fn<typeof fetch>();
let root: Root, host: HTMLDivElement;
let state: ReturnType<typeof useMonitorStream>;
let visibility = "visible";
const streams: {
  send: (data: unknown, event?: string) => void;
  close: () => void;
  signal: AbortSignal;
}[] = [];
const sample = (cpuPercent = 12) => ({
  measuredAt: new Date().toISOString(),
  cpuPercent,
  memoryUsedMb: 128,
  memoryAvailableMb: 896,
  diskUsedMb: null,
  diskAvailableMb: null,
  diskTotalMb: null,
});
function Harness({
  id = "server-a",
  format = "usage",
}: {
  id?: string;
  format?: "usage" | "stats";
}) {
  state = useMonitorStream(id, true, format);
  return null;
}
const render = async (id = "server-a", format: "usage" | "stats" = "usage") => {
  await act(async () => root.render(<Harness id={id} format={format} />));
  await act(async () => vi.advanceTimersByTimeAsync(50));
};
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  visibility = "visible";
  scope.value = "account-a:org-a";
  streams.length = 0;
  vi.spyOn(document, "visibilityState", "get").mockImplementation(
    () => visibility as DocumentVisibilityState,
  );
  fetcher.mockReset().mockImplementation(async (_url, init) => {
    const signal = init!.signal!;
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    let closed = false;
    const body = new ReadableStream<Uint8Array>({
      start(next) {
        controller = next;
      },
      cancel() {
        closed = true;
      },
    });
    signal.addEventListener(
      "abort",
      () => {
        if (!closed) {
          closed = true;
          controller.error(new DOMException("Aborted", "AbortError"));
        }
      },
      { once: true },
    );
    streams.push({
      signal,
      send(data, event = "usage") {
        controller.enqueue(
          new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
        );
      },
      close() {
        closed = true;
        controller.close();
      },
    });
    return new Response(body, { headers: { "content-type": "text/event-stream" } });
  });
  vi.stubGlobal("fetch", fetcher);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it("opts into usage, retains bounded real samples and clears readings on target/account switches", async () => {
  await render();
  expect(String(fetcher.mock.calls[0]?.[0])).toContain("format=usage");
  expect(state.isConnected).toBe(false);
  await act(async () => {
    for (let index = 0; index < 65; index++) streams[0]!.send(sample(index));
  });
  expect(state.usage?.cpuPercent).toBe(64);
  expect(state.history).toHaveLength(60);
  await render("server-b");
  expect(streams[0]!.signal.aborted).toBe(true);
  expect(state.usage).toBeNull();
  await act(async () => streams[1]!.send(sample(8)));
  scope.value = "account-b:org-b";
  await render("server-b");
  expect(streams[1]!.signal.aborted).toBe(true);
  expect(state.usage).toBeNull();
});
it("pauses hidden pages and resumes exactly one subscription when visible", async () => {
  await render();
  visibility = "hidden";
  await act(async () => document.dispatchEvent(new Event("visibilitychange")));
  expect(streams[0]!.signal.aborted).toBe(true);
  expect(state.paused).toBe(true);
  await act(async () => vi.advanceTimersByTimeAsync(60_000));
  expect(fetcher).toHaveBeenCalledTimes(1);
  visibility = "visible";
  await act(async () => document.dispatchEvent(new Event("visibilitychange")));
  await act(async () => vi.advanceTimersByTimeAsync(50));
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(state.paused).toBe(false);
});
it("retains the last reading after a disconnect and supports an explicit retry", async () => {
  await render();
  await act(async () => streams[0]!.send(sample(18)));
  await act(async () => streams[0]!.close());
  expect(state.usage?.cpuPercent).toBe(18);
  expect(state.isConnected).toBe(false);
  expect(state.error).toMatch(/disconnect/i);
  await act(async () => state.reconnect());
  await act(async () => streams[1]!.send(sample(20)));
  expect(state.isConnected).toBe(true);
  expect(state.error).toBeNull();
  expect(state.usage?.cpuPercent).toBe(20);
});
it("times out a stalled stream and never reports malformed readings as live", async () => {
  await render();
  await act(async () => vi.advanceTimersByTimeAsync(45_000));
  expect(state.error).toMatch(/delayed/);
  expect(state.isConnected).toBe(false);
  expect(streams[0]!.signal.aborted).toBe(true);
  await act(async () => state.reconnect());
  await act(async () => streams[1]!.send({ cpuPercent: 1 }));
  expect(state.usage).toBeNull();
  expect(state.error).toBeTruthy();
});
it("preserves the default host stats event format", async () => {
  await render("server-a", "stats");
  expect(String(fetcher.mock.calls[0]?.[0])).not.toContain("format=");
  await act(async () => streams[0]!.send({ cpu: 10, memUsed: 1024 }, "stats"));
  expect(state.stats).toMatchObject({ cpu: 10, memUsed: 1024 });
  expect(state.usage).toBeNull();
});
