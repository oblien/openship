// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRequestLogStream } from "./useRequestLogStream";

const api = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("@/lib/api", () => ({ api, getApiBaseUrl: () => "http://localhost:4000/api/" }));
class Source extends EventTarget {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;
  static all: Source[] = [];
  readyState = Source.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  constructor(readonly url: string) {
    super();
    Source.all.push(this);
  }
  open() {
    this.readyState = Source.OPEN;
    this.onopen?.();
  }
  close() {
    this.readyState = Source.CLOSED;
  }
  drop(terminal = false) {
    this.readyState = terminal ? Source.CLOSED : Source.CONNECTING;
    this.dispatchEvent(new Event("error"));
  }
}
const status = vi.fn();
const entry = vi.fn();
let stream: ReturnType<typeof useRequestLogStream>;
let root: Root;
let element: HTMLDivElement;
function Harness({ domains, enabled }: { domains: string[]; enabled: boolean }) {
  stream = useRequestLogStream({
    projectId: "project-a",
    domains,
    enabled,
    onEntry: entry,
    onStatus: status,
  });
  return null;
}
async function render(domains = ["app.example.com"], enabled = true) {
  await act(async () => root.render(<Harness domains={domains} enabled={enabled} />));
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("EventSource", Source);
  api.get.mockReset().mockResolvedValue({ kind: "self-hosted" });
  status.mockReset();
  entry.mockReset();
  Source.all = [];
  element = document.createElement("div");
  document.body.appendChild(element);
  root = createRoot(element);
});
afterEach(async () => {
  await act(async () => root.unmount());
  element.remove();
  vi.unstubAllGlobals();
});

describe("live traffic connection feedback", () => {
  it("reports reconnecting when the last open stream loses its connection", async () => {
    await render();
    await act(async () => Source.all[0]!.open());
    expect(status).toHaveBeenLastCalledWith({ state: "open" });
    await act(async () => Source.all[0]!.drop());
    expect(status).toHaveBeenLastCalledWith({ state: "connecting" });
    await act(async () => Source.all[0]!.open());
    expect(status).toHaveBeenLastCalledWith({ state: "open" });
  });

  it("keeps the aggregate live while another domain is still connected", async () => {
    await render(["a.example.com", "b.example.com"]);
    await act(async () => {
      Source.all[0]!.open();
      Source.all[1]!.open();
      Source.all[0]!.drop();
    });
    expect(status).toHaveBeenLastCalledWith({ state: "open" });
  });

  it("reconnects a terminal failure once and discards queued events from the replaced stream", async () => {
    await render();
    const old = Source.all[0]!;
    await act(async () => old.drop(true));
    expect(status).toHaveBeenLastCalledWith({ state: "error", message: "closed" });
    await act(async () => {
      stream.reconnect();
      stream.reconnect();
    });
    expect(api.get).toHaveBeenCalledTimes(2);
    expect(Source.all).toHaveLength(2);
    expect(old.readyState).toBe(Source.CLOSED);
    await act(async () => {
      old.dispatchEvent(new MessageEvent("request", { data: JSON.stringify({ path: "/old" }) }));
      Source.all[1]!.dispatchEvent(
        new MessageEvent("request", { data: JSON.stringify({ path: "/new" }) }),
      );
    });
    expect(entry).toHaveBeenCalledOnce();
    expect(entry.mock.calls[0]?.[0]?.path).toBe("/new");
  });

  it("retries a Cloud token failure without opening a self-hosted fallback", async () => {
    api.get.mockResolvedValueOnce({ kind: "cloud" });
    await render();
    expect(status).toHaveBeenLastCalledWith({ state: "unavailable" });
    expect(Source.all).toHaveLength(0);
    api.get.mockResolvedValueOnce({
      kind: "cloud",
      url: "https://cloud.example.com/logs",
      token: "test-only",
    });
    await act(async () => stream.reconnect());
    expect(Source.all).toHaveLength(1);
    expect(Source.all[0]!.url).toBe("https://cloud.example.com/logs?token=test-only");
  });
});
