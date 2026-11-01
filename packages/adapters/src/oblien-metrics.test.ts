import { afterEach, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { Oblien } from "./oblien";
import { workspaceMetricsStream } from "./oblien-metrics";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
const frame = (data: unknown) => new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`);

it("keeps provider credentials server-side, rejects redirects and releases the reader on early return", async () => {
  const cancel = vi.fn();
  const fetcher = vi.fn(
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(frame({ cpuUsage: 12.5 }));
          },
          cancel,
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
  );
  vi.stubGlobal("fetch", fetcher);
  const client = new Oblien({ token: "old-token" });
  client.setToken("scoped-token");
  for await (const value of client.streamWorkspaceMetrics("ws-owned")) {
    expect(value).toEqual({ cpuUsage: 12.5 });
    break;
  }
  expect(cancel).toHaveBeenCalledOnce();
  const [url, request] = fetcher.mock.calls[0]! as unknown as [URL, RequestInit];
  expect(url.href).toBe("https://api.oblien.com/workspace/ws-owned/stats/stream");
  expect(request.redirect).toBe("error");
  expect(new Headers(request.headers).get("Authorization")).toBe("Bearer scoped-token");
  expect(request.signal?.aborted).toBe(true);
});
it("renews rejected stream credentials only when the caller explicitly reconnects", async () => {
  const refresh = vi.fn(async () => ({
    token: "renewed-token",
    expiresAt: new Date(Date.now() + 1800_000).toISOString(),
  }));
  const invalidate = vi.fn(async () => {});
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(new Response("", { status: 401 }))
    .mockResolvedValueOnce(
      new Response(frame({ cpuUsage: 7 }), {
        headers: { "content-type": "text/event-stream" },
      }),
    );
  vi.stubGlobal("fetch", fetcher);
  const client = new Oblien({
    token: "rejected-token",
    tokenRefresh: {
      expiresAt: new Date(Date.now() + 1800_000).toISOString(),
      refresh,
      invalidate,
    },
  });
  await expect(
    client.streamWorkspaceMetrics("owned")[Symbol.asyncIterator]().next(),
  ).rejects.toThrow("Live resource usage is unavailable");
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(refresh).not.toHaveBeenCalled();
  for await (const sample of client.streamWorkspaceMetrics("owned")) {
    expect(sample).toEqual({ cpuUsage: 7 });
    break;
  }
  expect(new Headers(fetcher.mock.calls[1]![1].headers).get("authorization")).toBe(
    "Bearer renewed-token",
  );
  expect(refresh).toHaveBeenCalledOnce();
  expect(invalidate).toHaveBeenCalledExactlyOnceWith("rejected-token");
});

it("aborts a real provider socket while waiting for the next frame", async () => {
  let closed!: () => void;
  const closure = new Promise<void>((resolve) => {
    closed = resolve;
  });
  const server = createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(`data: {"cpuUsage":1}\n\n`);
    request.on("close", closed);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address() as { port: number };
    const abort = new AbortController();
    const source = new Oblien({ token: "test", baseUrl: `http://127.0.0.1:${address.port}` })
      .streamWorkspaceMetrics("owned", abort.signal)
      [Symbol.asyncIterator]();
    expect((await source.next()).value).toEqual({ cpuUsage: 1 });
    const waiting = source.next();
    abort.abort();
    await expect(waiting).rejects.toThrow();
    await closure;
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
it("rejects private provider error bodies and oversized incomplete frames", async () => {
  const open = async () => new Response("private-token", { status: 403 });
  await expect(workspaceMetricsStream(open).next()).rejects.toThrow(
    "Live resource usage is unavailable",
  );
  const oversized = async () =>
    new Response(`data: ${"x".repeat(70_000)}`, {
      headers: { "content-type": "text/event-stream" },
    });
  await expect(workspaceMetricsStream(oversized).next()).rejects.toThrow(
    "Invalid live resource usage",
  );
});
it("bounds a provider connection that never responds", async () => {
  vi.useFakeTimers();
  const source = workspaceMetricsStream(
    (signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
  );
  const waiting = expect(source.next()).rejects.toThrow("timed out");
  await vi.advanceTimersByTimeAsync(45_000);
  await waiting;
  expect(vi.getTimerCount()).toBe(0);
});

it("reconnects a cut-off provider stream and releases each reader before reopening", async () => {
  vi.useFakeTimers();
  const cancel = vi.fn();
  const streams: ReadableStreamDefaultController<Uint8Array>[] = [];
  const open = vi.fn(
    async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            streams.push(controller);
          },
          cancel,
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
  );
  const abort = new AbortController();
  const source = workspaceMetricsStream(open, abort.signal);
  const first = source.next();
  await vi.advanceTimersByTimeAsync(0);
  streams[0]!.enqueue(frame({ cpuUsage: 1 }));
  expect((await first).value).toEqual({ cpuUsage: 1 });
  const next = source.next();
  streams[0]!.enqueue(
    new TextEncoder().encode('event: error\ndata: {"error":"private provider detail"}\n\n'),
  );
  await vi.advanceTimersByTimeAsync(1000);
  expect(cancel).toHaveBeenCalledOnce();
  expect(open).toHaveBeenCalledTimes(2);
  streams[1]!.enqueue(frame({ cpuUsage: 2 }));
  expect((await next).value).toEqual({ cpuUsage: 2 });
  await source.return(undefined);
  expect(cancel).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
});

it("bounds repeated failures and never retries an authorization refusal", async () => {
  vi.useFakeTimers();
  const failing = vi.fn(async () => new Response("private", { status: 503 }));
  const failed = expect(workspaceMetricsStream(failing).next()).rejects.toThrow("unavailable");
  await vi.advanceTimersByTimeAsync(7000);
  await failed;
  expect(failing).toHaveBeenCalledTimes(4);
  const forbidden = vi.fn(async () => new Response("private", { status: 403 }));
  await expect(workspaceMetricsStream(forbidden).next()).rejects.toThrow("unavailable");
  expect(forbidden).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it("cancels a pending retry without reopening or retaining its timer", async () => {
  vi.useFakeTimers();
  const abort = new AbortController();
  const open = vi.fn(async () => new Response("", { status: 503 }));
  const failed = expect(workspaceMetricsStream(open, abort.signal).next()).rejects.toThrow("gone");
  await vi.advanceTimersByTimeAsync(0);
  abort.abort(new Error("gone"));
  await failed;
  await vi.advanceTimersByTimeAsync(10_000);
  expect(open).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});
