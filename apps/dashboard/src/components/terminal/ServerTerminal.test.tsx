// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { PtyConnection } from "@/hooks/usePtyConnection";
import { ServerTerminal } from "./ServerTerminal";

const mocks = vi.hoisted(() => {
  let loadWebgl = () => {};
  const webglLoaded = new Promise<void>((resolve) => {
    loadWebgl = resolve;
  });
  return {
    webglLoaded,
    loadWebgl: () => loadWebgl(),
    open: vi.fn(),
    dispose: vi.fn(),
    observe: vi.fn(),
  };
});
vi.mock("@/hooks/usePtyConnection", () => ({
  usePtyConnection: (): PtyConnection => ({
    isConnecting: false,
    isConnected: false,
    reconnectAttempts: 0,
    lastError: null,
    lastErrorMessage: null,
    sendInput: vi.fn(),
    sendResize: vi.fn(),
    disconnect: vi.fn(),
    reconnect: vi.fn(),
    terminate: vi.fn(),
  }),
}));
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    options = {};
    loadAddon() {}
    open() {
      mocks.open();
    }
    onData() {}
    onSelectionChange() {}
    dispose() {
      mocks.dispose();
    }
  },
}));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit() {}
  },
}));
vi.mock("@xterm/addon-web-links", () => ({ WebLinksAddon: class {} }));
// Hold the WebGL renderer import open until the test releases it.
vi.mock("@xterm/addon-webgl", async () => {
  await mocks.webglLoaded;
  return {
    WebglAddon: class {
      onContextLoss() {}
    },
  };
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("disposes the terminal and attaches nothing when unmounted while the WebGL renderer loads", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe = mocks.observe;
      disconnect() {}
    },
  );
  const rejections: unknown[] = [];
  const onRejection = (reason: unknown) => rejections.push(reason);
  process.on("unhandledRejection", onRejection);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<ServerTerminal serverId="srv_1" enabled />));
    // The terminal is open and setup is now waiting on the WebGL import.
    await vi.waitFor(() => expect(mocks.open).toHaveBeenCalledOnce());
    await act(async () => root.unmount());
    const addListener = vi.spyOn(window, "addEventListener");

    mocks.loadWebgl();
    await vi.dynamicImportSettled();

    expect(rejections).toEqual([]);
    expect(mocks.dispose).toHaveBeenCalledOnce();
    expect(mocks.observe).not.toHaveBeenCalled();
    expect(addListener).not.toHaveBeenCalledWith("resize", expect.any(Function));
  } finally {
    process.off("unhandledRejection", onRejection);
    host.remove();
  }
});
