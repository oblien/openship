// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Terminal } from "@xterm/xterm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useBuildStream, useLogStream } from "./useSSEConnection";
vi.mock("@/lib/api", () => ({ getApiBaseUrl: () => "http://localhost:4000/api/" }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function liveResponse() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  return { response: new Response(stream), controller };
}

let root: Root;
let container: HTMLDivElement;
let logs: ReturnType<typeof useLogStream>;
let build: ReturnType<typeof useBuildStream>;
const fetcher = vi.fn();
const onLog = vi.fn();
const onError = vi.fn();
const onDisconnect = vi.fn();
const buildWrite = vi.fn();
const buildTerminal = { current: { write: buildWrite } as unknown as Terminal };
function Harness() {
  logs = useLogStream({ autoWriteToTerminal: false, callbacks: { onLog }, onError, onDisconnect });
  return null;
}
function BuildHarness() {
  build = useBuildStream({ terminalRef: buildTerminal, callbacks: { onLog } });
  return null;
}
async function connect(target: string) {
  let done!: Promise<void>;
  await act(async () => {
    done = logs.connect(target);
  });
  return { done };
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", fetcher);
  fetcher.mockReset();
  onLog.mockReset();
  onError.mockReset();
  onDisconnect.mockReset();
  buildWrite.mockReset();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root.render(<Harness />));
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("runtime log stream ownership (#668)", () => {
  it("exposes current loading, connected and disconnected state without replacing its controls", async () => {
    const pending = deferred<Response>();
    const live = liveResponse();
    fetcher.mockReturnValueOnce(pending.promise);
    const controls = logs;
    const { done } = await connect("current");
    expect(logs).toBe(controls);
    expect(logs.isConnecting).toBe(true);
    await act(async () => pending.resolve(live.response));
    expect(logs).toBe(controls);
    expect(logs.isConnected).toBe(true);
    expect(logs.isConnecting).toBe(false);
    await act(async () => {
      live.controller.close();
      await done;
    });
    expect(logs.isConnected).toBe(false);
  });

  it("allows switching targets while the old HTTP request is still pending", async () => {
    const old = deferred<Response>();
    const live = liveResponse();
    fetcher.mockReturnValueOnce(old.promise).mockResolvedValueOnce(live.response);
    const first = await connect("old");
    const second = await connect("new");
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      "http://localhost:4000/api/projects/old/logs/stream",
      "http://localhost:4000/api/projects/new/logs/stream",
    ]);
    expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true);
    await act(async () => {
      old.reject(new DOMException("aborted", "AbortError"));
      await first.done;
    });
    expect(logs.isConnected).toBe(true);
    expect(onDisconnect).not.toHaveBeenCalled();
    await act(async () => {
      live.controller.close();
      await second.done;
    });
  });

  it("does not let the old stream's EOF disconnect its replacement", async () => {
    const old = liveResponse();
    const live = liveResponse();
    fetcher.mockResolvedValueOnce(old.response).mockResolvedValueOnce(live.response);
    const first = await connect("old");
    const second = await connect("new");
    await act(async () => {
      old.controller.close();
      await first.done;
    });
    expect(logs.isConnected).toBe(true);
    expect(onDisconnect).not.toHaveBeenCalled();
    await act(async () => {
      live.controller.close();
      await second.done;
    });
  });

  it("surfaces an HTTP failure through the stable status object", async () => {
    fetcher.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "server unavailable" }), { status: 503 }),
    );
    const { done } = await connect("current");
    await act(async () => done);
    expect(logs.isConnecting).toBe(false);
    expect(logs.error?.message).toContain("server unavailable");
    expect(onError).toHaveBeenCalledOnce();
  });

  it("reports a connection timeout and aborts the pending fetch", async () => {
    fetcher.mockImplementation(
      (_url, { signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    );
    const { done } = await connect("slow");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true);
    expect(logs.error?.message).toMatch(/timed out/i);
    expect(logs.isConnecting).toBe(false);
    await done;
  });

  it("aborts a pending stream when its viewer unmounts", async () => {
    const pending = deferred<Response>();
    fetcher.mockReturnValueOnce(pending.promise);
    const { done } = await connect("current");
    await act(async () => root.render(null));
    expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true);
    await act(async () => {
      pending.reject(new DOMException("aborted", "AbortError"));
      await done;
    });
  });

  it("shares an active connection for repeated requests for the same target", async () => {
    const live = liveResponse();
    fetcher.mockResolvedValue(live.response);
    const first = await connect("current");
    const second = await connect("current");
    expect(fetcher).toHaveBeenCalledOnce();
    await act(async () => {
      live.controller.close();
      await first.done;
      await second.done;
    });
  });

  it("keeps build streaming active when connection status rerenders its caller", async () => {
    await act(async () => root.render(<BuildHarness />));
    const live = liveResponse();
    fetcher.mockResolvedValueOnce(live.response);
    let done!: Promise<void>;
    await act(async () => {
      done = build.connect("deployment", false);
    });
    expect(build.isConnected).toBe(true);
    expect(fetcher.mock.calls[0][1].signal.aborted).toBe(false);
    await act(async () => {
      build.disconnect();
      live.controller.close();
      await done;
    });
  });

  it.each(["eof", "error"])("reconnects build logs after an unexpected %s", async (end) => {
    await act(async () => root.render(<BuildHarness />));
    const first = liveResponse();
    const next = liveResponse();
    fetcher.mockResolvedValueOnce(first.response).mockResolvedValueOnce(next.response);
    let done!: Promise<void>;
    await act(async () => { done = build.connect("deployment", false, 12); });
    await act(async () => {
      if (end === "eof") first.controller.close();
      else first.controller.error(new Error("connection reset"));
      await done;
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      "http://localhost:4000/api/deployments/deployment/stream?since=12",
      "http://localhost:4000/api/deployments/deployment/stream?since=12",
    ]);
    expect(build.isConnected).toBe(true);
    await act(async () => {
      build.disconnect();
      next.controller.close();
    });
  });

  it("retries a failed initial read without starting a build", async () => {
    await act(async () => root.render(<BuildHarness />));
    const next = liveResponse();
    fetcher.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(next.response);
    await act(async () => {
      await build.connect("deployment", false);
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(fetcher.mock.calls.map(([, options]) => options.method)).toEqual(["GET", "GET"]);
    expect(build.isConnected).toBe(true);
    await act(async () => { build.disconnect(); next.controller.close(); });
  });

  it("resumes after the latest build event and filters replay before writing to the terminal", async () => {
    await act(async () => root.render(<BuildHarness />));
    const first = liveResponse();
    const next = liveResponse();
    fetcher.mockResolvedValueOnce(first.response).mockResolvedValueOnce(next.response);
    const frame = (eventId: number, text: string) => new TextEncoder().encode(
      `data: ${JSON.stringify({ type: "log", eventId, data: btoa(text) })}\n\n`,
    );
    let done!: Promise<void>;
    await act(async () => { done = build.connect("deployment", false, 12); });
    await act(async () => {
      first.controller.enqueue(frame(12, "already seeded\n"));
      first.controller.enqueue(frame(13, "first\n"));
      first.controller.close();
      await done;
      await vi.advanceTimersByTimeAsync(1_000);
      next.controller.enqueue(frame(13, "first\n"));
      next.controller.enqueue(frame(14, "second\n"));
    });
    expect(fetcher.mock.calls[1][0]).toBe("http://localhost:4000/api/deployments/deployment/stream?since=13");
    expect(buildWrite.mock.calls.map(([bytes]) => new TextDecoder().decode(bytes))).toEqual([
      "first\n", "second\n",
    ]);
    expect(onLog.mock.calls.map(([message]) => message.eventId)).toEqual([13, 14]);
    await act(async () => { build.disconnect(); next.controller.close(); });
  });

  it.each([401, 403])("does not retry an HTTP %i even with an unfamiliar message", async (status) => {
    await act(async () => root.render(<BuildHarness />));
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ error: "Access denied" }), { status }));
    await act(async () => {
      await build.connect("deployment", false);
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(build.isReconnecting).toBe(false);
    expect(build.error?.message).toContain("Access denied");
  });

  it.each([true, false])("does not retry a terminal build outcome (success=%s)", async (success) => {
    await act(async () => root.render(<BuildHarness />));
    fetcher.mockResolvedValueOnce(new Response(`data: ${JSON.stringify({ type: "complete", success })}\n\n`));
    await act(async () => {
      await build.connect("deployment", false);
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(build.isReconnecting).toBe(false);
  });

  it("keeps a replacement attempt pending when its predecessor finishes", async () => {
    await act(async () => root.render(<BuildHarness />));
    const old = deferred<Response>();
    const next = deferred<Response>();
    fetcher.mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
    let first!: Promise<void>;
    let second!: Promise<void>;
    await act(async () => { first = build.connect("old", false); });
    await act(async () => { second = build.connect("new", false); });
    await act(async () => {
      old.reject(new DOMException("aborted", "AbortError"));
      await first;
    });
    expect(build.isConnecting).toBe(true);
    await act(async () => { await build.connect("new", false); });
    expect(fetcher).toHaveBeenCalledTimes(2);
    await act(async () => {
      build.disconnect();
      next.reject(new DOMException("aborted", "AbortError"));
      await second;
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
