// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
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
const fetcher = vi.fn();
const onLog = vi.fn();
const onError = vi.fn();
const onDisconnect = vi.fn();
function Harness() {
  logs = useLogStream({ autoWriteToTerminal: false, callbacks: { onLog }, onError, onDisconnect });
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
    let build!: ReturnType<typeof useBuildStream>;
    function BuildHarness() {
      build = useBuildStream({ onDisconnect: () => {} });
      return null;
    }
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
});
