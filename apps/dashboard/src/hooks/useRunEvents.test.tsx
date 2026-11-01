// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { managedPreparationFixture } from "../../../../packages/contracts/test/managed-network-fixtures";
import type { ManagedNetworkPreparation } from "@repo/core";
import { useNetworkSetup } from "./useNetworkSetup";

vi.mock("@/lib/api/client", () => ({
  getApiBaseUrl: () => "http://localhost:4000/api/",
  getActiveOrganizationId: () => "org-a",
}));

const fixture = managedPreparationFixture();
const url = (id = fixture.id) =>
  `http://localhost:4000/api/system/networks/preparations/${encodeURIComponent(id)}/stream`;
function response(signal: AbortSignal) {
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
  const raw = (value: string) => controller.enqueue(new TextEncoder().encode(value));
  return {
    value: new Response(body, { headers: { "Content-Type": "text/event-stream" } }),
    send: (run: ManagedNetworkPreparation) =>
      raw(
        `event: snapshot\nid: ${run.sequence}\ndata: ${JSON.stringify({ type: "snapshot", run })}\n\n`,
      ),
    complete: () => raw('event: complete\ndata: {"type":"complete"}\n\n'),
    ping: () => raw("event: ping\ndata: {}\n\n"),
    end: () => {
      closed = true;
      controller.close();
    },
  };
}

let root: Root;
let element: HTMLDivElement;
let network: ReturnType<typeof useNetworkSetup<"preparation">>;
const opened: ReturnType<typeof response>[] = [];
const fetcher = vi.fn<typeof fetch>();
function Harness({ id = fixture.id, enabled = true }: { id?: string; enabled?: boolean }) {
  network = useNetworkSetup("preparation", id, enabled);
  return null;
}
async function render(id = fixture.id, enabled = true) {
  await act(async () => root.render(<Harness id={id} enabled={enabled} />));
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0);
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", fetcher);
  opened.length = 0;
  fetcher.mockReset().mockImplementation(async (_url, options) => {
    const live = response(options!.signal!);
    opened.push(live);
    return live.value;
  });
  element = document.createElement("div");
  document.body.appendChild(element);
  root = createRoot(element);
});
afterEach(async () => {
  await act(async () => root.unmount());
  element.remove();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("reconnecting run progress", () => {
  it("uses one organization-scoped GET during live progress and performs no status polling", async () => {
    await render();
    await act(async () => opened[0]!.send(fixture));
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    await act(async () => opened[0]!.send({ ...fixture, sequence: 2 }));
    expect(network.progress?.sequence).toBe(2);
    expect(network.stream.connected).toBe(true);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0]).toMatchObject([
      url(),
      {
        method: "GET",
        credentials: "include",
        headers: { "X-Organization-Id": "org-a", Accept: "text/event-stream" },
      },
    ]);
  });
  it("reconnects after EOF, replaces the snapshot without duplicating logs, and closes at completion", async () => {
    const run = {
      ...fixture,
      hosts: fixture.hosts.map((host) => ({
        ...host,
        logs: [
          {
            step: "python3" as const,
            level: "info" as const,
            timestamp: new Date().toISOString(),
            message: "Installed Python",
          },
        ],
      })),
    };
    await render();
    await act(async () => {
      opened[0]!.send(run);
      opened[0]!.end();
    });
    expect(network.stream.reconnecting).toBe(true);
    await act(async () => vi.advanceTimersByTimeAsync(999));
    expect(fetcher).toHaveBeenCalledOnce();
    await act(async () => vi.advanceTimersByTimeAsync(1));
    await act(async () => opened[1]!.send(run));
    expect(network.progress?.hosts[0]!.logs).toHaveLength(1);
    await act(async () => {
      opened[1]!.send({ ...run, sequence: 2, status: "failed" });
      opened[1]!.complete();
    });
    expect(network.progress?.status).toBe("failed");
    expect(network.stream.reconnecting).toBe(false);
    await act(async () => vi.advanceTimersByTimeAsync(90_000));
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(
      fetcher.mock.calls.every(([, request]) => request?.method === "GET" && !request.body),
    ).toBe(true);
  });
  it("backs off repeated short connections even when each one opens and replays a snapshot", async () => {
    await render();
    for (const [index, delay] of [1000, 2000, 4000, 8000, 15000, 15000].entries()) {
      await act(async () => {
        opened[index]!.send(fixture);
        opened[index]!.end();
      });
      await act(async () => vi.advanceTimersByTimeAsync(delay - 1));
      expect(fetcher).toHaveBeenCalledTimes(index + 1);
      await act(async () => vi.advanceTimersByTimeAsync(1));
      expect(fetcher).toHaveBeenCalledTimes(index + 2);
    }
  });
  it.each([401, 403, 404])("stops reconnecting after HTTP %s", async (status) => {
    fetcher.mockResolvedValueOnce(Response.json({ error: "Unavailable" }, { status }));
    await render();
    expect(network.stream.error).toMatchObject({ status });
    expect(network.stream.reconnecting).toBe(false);
    await act(async () => vi.advanceTimersByTimeAsync(120_000));
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("reconnects a silent stream after the idle deadline", async () => {
    await render();
    await act(async () => opened[0]!.send(fixture));
    await act(async () => vi.advanceTimersByTimeAsync(61_000));
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[0]![1]!.signal!.aborted).toBe(true);
  });
  it("keeps a healthy idle operation connected while heartbeat frames arrive", async () => {
    await render();
    await act(async () => opened[0]!.send(fixture));
    for (let i = 0; i < 8; i++) {
      await act(async () => vi.advanceTimersByTimeAsync(15_000));
      await act(async () => opened[0]!.ping());
    }
    expect(fetcher).toHaveBeenCalledOnce();
    expect(network.stream.connected).toBe(true);
  });
  it("ignores a late POST response and older stream progress after a newer snapshot", async () => {
    await render();
    await act(async () => opened[0]!.send({ ...fixture, sequence: 9, status: "ready" }));
    await act(async () => network.update({ ...fixture, sequence: 8, status: "preparing" }));
    await act(async () => opened[0]!.send({ ...fixture, sequence: 7, status: "preparing" }));
    expect(network.progress).toMatchObject({ sequence: 9, status: "ready" });
  });
  it("cancels the previous target, clears its visible progress, and never opens a disabled stream", async () => {
    await render();
    await act(async () => opened[0]!.send(fixture));
    await render("next/setup");
    expect(fetcher.mock.calls[0]![1]!.signal!.aborted).toBe(true);
    expect(network.progress).toBeNull();
    await act(async () => opened[1]!.send({ ...fixture, id: "next/setup" }));
    expect(network.progress?.id).toBe("next/setup");
    expect(fetcher.mock.calls[1]![0]).toBe(url("next/setup"));
    await render("next/setup", false);
    expect(network.progress).toBeNull();
    expect(fetcher.mock.calls[1]![1]!.signal!.aborted).toBe(true);
    await act(async () => vi.advanceTimersByTimeAsync(120_000));
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("manual reconnect attaches with GET and removes old retry timers", async () => {
    await render();
    await act(async () => opened[0]!.end());
    await act(async () => network.stream.reconnect());
    expect(fetcher).toHaveBeenCalledTimes(2);
    await act(async () => vi.advanceTimersByTimeAsync(1500));
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[1]![1]!.method).toBe("GET");
  });
  it("does not reconnect after unmount", async () => {
    await render();
    await act(async () => opened[0]!.end());
    await act(async () => root.render(null));
    await act(async () => vi.advanceTimersByTimeAsync(120_000));
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
