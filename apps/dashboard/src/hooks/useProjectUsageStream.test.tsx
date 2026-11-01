// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockSingleUsage } from "@/components/monitoring/fixtures";
import { useProjectUsageStream } from "./useProjectUsageStream";

const target = vi.hoisted(() => ({ scope: "org-a" }));
vi.mock("@/context/CloudResourceContext", () => ({ useCloudResourceKey: () => target.scope }));
vi.mock("@/lib/api/client", () => ({
  getApiBaseUrl: () => "http://localhost:4000/api/",
  getActiveOrganizationId: () => target.scope,
  getApiErrorMessage: (error: Error) => error.message,
}));

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
  return {
    value: new Response(body, { headers: { "Content-Type": "text/event-stream" } }),
    send(event: string, data: unknown) {
      controller.enqueue(
        new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
      );
    },
    end() {
      closed = true;
      controller.close();
    },
    fail() {
      closed = true;
      controller.error(new TypeError("Network connection lost"));
    },
    isClosed: () => closed,
  };
}
const fetcher = vi.fn<typeof fetch>();
const opened: ReturnType<typeof response>[] = [];
let root: Root;
let element: HTMLDivElement;
let state: ReturnType<typeof useProjectUsageStream>;
function Harness({ projectId, enabled }: { projectId: string; enabled: boolean }) {
  state = useProjectUsageStream(projectId, enabled);
  return null;
}
async function render(projectId = "project-a", enabled = true) {
  await act(async () => root.render(<Harness projectId={projectId} enabled={enabled} />));
  await act(async () => vi.advanceTimersByTimeAsync(50));
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", fetcher);
  target.scope = "org-a";
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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("project resource monitoring connections", () => {
  it("reports an EOF before the first sample instead of remaining an empty loading view", async () => {
    await render();
    await act(async () => opened[0]!.end());
    expect(state.usage).toBeNull();
    expect(state.isConnected).toBe(false);
    expect(state.isConnecting).toBe(false);
    expect(state.error).toMatch(/disconnected/i);
    await act(async () => vi.advanceTimersByTimeAsync(120_000));
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it.each(["end", "fail"] as const)(
    "keeps the last sample after a stream %s and reconnects once on request",
    async (finish) => {
      await render();
      await act(async () => opened[0]!.send("usage", mockSingleUsage));
      expect(state.isConnecting).toBe(false);
      await act(async () => opened[0]![finish]());
      expect(state.usage?.overall).toEqual(mockSingleUsage.overall);
      expect(state.error).toBeTruthy();
      expect(state.isConnected).toBe(false);
      await act(async () => {
        state.reconnect();
        state.reconnect();
      });
      expect(state.isConnecting).toBe(true);
      await act(async () => vi.advanceTimersByTimeAsync(50));
      expect(fetcher).toHaveBeenCalledTimes(2);
      await act(async () => opened[1]!.send("usage", mockSingleUsage));
      expect(state.error).toBeNull();
      expect(state.isConnected).toBe(true);
      expect(fetcher.mock.calls.every(([, options]) => options?.method === "GET")).toBe(true);
      expect(fetcher.mock.calls[1]?.[1]?.headers).toMatchObject({ "X-Organization-Id": "org-a" });
    },
  );

  it.each([401, 404, 502])("surfaces HTTP %s and waits for a manual retry", async (status) => {
    fetcher.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "Resource read unavailable" }), { status }),
    );
    await render();
    expect(state.error).toContain("Resource read unavailable");
    expect(state.isConnecting).toBe(false);
    await act(async () => vi.advanceTimersByTimeAsync(120_000));
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("times out a request whose response headers never arrive", async () => {
    fetcher.mockImplementationOnce(
      (_url, options) =>
        new Promise((_resolve, reject) => {
          options!.signal!.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        }),
    );
    await render();
    await act(async () => vi.advanceTimersByTimeAsync(15_000));
    expect(state.error).toMatch(/timed out/i);
    expect(state.isConnecting).toBe(false);
  });

  it("does not let keep-alives hide a missing first resource sample", async () => {
    await render();
    for (let i = 0; i < 6; i++) {
      await act(async () => opened[0]!.send("ping", {}));
      await act(async () => vi.advanceTimersByTimeAsync(10_000));
    }
    expect(state.error).toMatch(/resource usage timed out/i);
    expect(state.isConnecting).toBe(false);
    expect(opened[0]!.isClosed()).toBe(true);
  });

  it("detects an idle connection after previously receiving data", async () => {
    await render();
    await act(async () => opened[0]!.send("usage", mockSingleUsage));
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(state.isConnected).toBe(false);
    expect(state.error).toMatch(/disconnected/i);
    expect(state.usage?.overall).toEqual(mockSingleUsage.overall);
  });

  it("keeps a backend observation error visible until a later valid sample", async () => {
    await render();
    await act(async () => opened[0]!.send("usage", mockSingleUsage));
    await act(async () => opened[0]!.send("error", { error: "Server temporarily unreachable" }));
    expect(state.error).toBe("Server temporarily unreachable");
    expect(state.usage?.overall).toEqual(mockSingleUsage.overall);
    await act(async () => opened[0]!.send("usage", mockSingleUsage));
    expect(state.error).toBeNull();
  });

  it.each(["project", "account"])("clears old samples when the %s changes", async (kind) => {
    await render();
    await act(async () => opened[0]!.send("usage", mockSingleUsage));
    if (kind === "account") target.scope = "org-b";
    await render(kind === "project" ? "project-b" : "project-a");
    expect(opened[0]!.isClosed()).toBe(true);
    expect(state.usage).toBeNull();
    expect(state.error).toBeNull();
    expect(state.isConnecting).toBe(true);
  });

  it("disabling or unmounting stops reads without scheduling reconnection", async () => {
    await render();
    await render("project-a", false);
    await act(async () => vi.advanceTimersByTimeAsync(120_000));
    expect(opened[0]!.isClosed()).toBe(true);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(state.isConnected).toBe(false);
    expect(state.isConnecting).toBe(false);
  });
});
