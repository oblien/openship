// @vitest-environment happy-dom
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { useLogStream } from "@/hooks/useSSEConnection";
import { LiveServiceLogsTerminal } from "./LiveServiceLogsTerminal";

const h = vi.hoisted(() => ({
  options: {} as Parameters<typeof useLogStream>[0],
  controls: { connect: vi.fn(), disconnect: vi.fn() },
  terminal: { reset: vi.fn(), write: vi.fn() },
}));
vi.mock("@/hooks/useSSEConnection", () => ({ useLogStream: (options: typeof h.options) => {
  h.options = options;
  return h.controls;
} }));
vi.mock("../TerminalSurface", () => ({ default: ({ onReady }: { onReady: (terminal: unknown) => void }) => {
  useEffect(() => { onReady(h.terminal); }, []);
  return <div data-terminal />;
} }));
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  h.controls.connect.mockReset().mockResolvedValue(undefined);
  h.controls.disconnect.mockReset();
  h.terminal.write.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const render = (active = true) => act(async () => root.render(
  <LiveServiceLogsTerminal deploymentId="deployment" projectId="project" serviceId="service" active={active} />,
));

it("connects only the visible, ready terminal and disconnects when hidden", async () => {
  await render(false);
  expect(h.controls.connect).not.toHaveBeenCalled();
  await render();
  await render();
  expect(h.controls.connect).toHaveBeenCalledOnce();
  expect(h.controls.connect).toHaveBeenCalledWith("projects/project/services/service/logs/stream?tail=100&deploymentId=deployment");
  await render(false);
  expect(h.controls.disconnect).toHaveBeenCalledOnce();
});

it("coalesces duplicate disconnect notifications into at most five retry attempts", async () => {
  await render();
  for (let i = 0; i < 7; i++) {
    await act(async () => {
      h.options?.onDisconnect?.();
      h.options?.onError?.(new Error("connection dropped"));
      await vi.advanceTimersByTimeAsync(2000);
    });
  }
  expect(h.controls.connect).toHaveBeenCalledTimes(6); // Initial connection + five retries.
});

it("cancels retries after a clean end and after leaving the tab", async () => {
  await render();
  await act(async () => {
    h.options?.onDisconnect?.();
    h.options?.callbacks?.onContainerExit?.(0, "Log stream ended");
    await vi.advanceTimersByTimeAsync(2000);
  });
  expect(h.controls.connect).toHaveBeenCalledOnce();
  await render(false);
  await render();
  await act(async () => { h.options?.onDisconnect?.(); });
  await render(false);
  await act(async () => vi.advanceTimersByTimeAsync(2000));
  expect(h.controls.connect).toHaveBeenCalledTimes(2);
});

it("shows permanent HTTP failures without repeatedly requesting forbidden logs", async () => {
  await render();
  await act(async () => {
    h.options?.onError?.(Object.assign(new Error("Access denied"), { status: 403 }));
    h.options?.onDisconnect?.();
    await vi.advanceTimersByTimeAsync(10000);
  });
  expect(h.controls.connect).toHaveBeenCalledOnce();
  expect(h.terminal.write).toHaveBeenCalledWith(expect.stringContaining("Access denied"));
});

it("keeps plain Docker messages on separate lines and preserves raw stream bytes", async () => {
  await render();
  h.options?.callbacks?.onLog?.({ type: "log", message: "first" }, "first");
  const raw = new Uint8Array([13, 65]);
  h.options?.callbacks?.onLog?.({ type: "log", data: "DUE=" }, "", raw);
  expect(h.terminal.write.mock.calls).toEqual([["first\r\n"], [raw]]);
});
