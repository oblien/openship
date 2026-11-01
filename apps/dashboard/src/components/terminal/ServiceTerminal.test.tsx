// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/components/i18n-provider";
import { baseDictionary } from "@/i18n";
import type { PtyConnection, usePtyConnection } from "@/hooks/usePtyConnection";
import { ServiceTerminal } from "./ServiceTerminal";

const mocks = vi.hoisted(() => ({
  connection: {} as PtyConnection,
  args: null as Parameters<typeof usePtyConnection>[0] | null,
  dispose: vi.fn(),
  connected: vi.fn(),
}));
vi.mock("@/hooks/usePtyConnection", () => ({
  usePtyConnection: (args: Parameters<typeof usePtyConnection>[0]) => {
    mocks.args = args;
    return mocks.connection;
  },
}));
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    options = {};
    cols = 80;
    rows = 24;
    output = document.createElement("pre");
    loadAddon() {}
    open(host: HTMLElement) { host.append(this.output); }
    write(chunk: Uint8Array) { this.output.textContent += new TextDecoder().decode(chunk); }
    onData() {}
    onSelectionChange() {}
    focus() {}
    dispose() { mocks.dispose(); this.output.remove(); }
  },
}));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));
vi.mock("@xterm/addon-web-links", () => ({ WebLinksAddon: class {} }));

const copy = baseDictionary.projectDetail.services.connection;
let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.connection = {
    isConnecting: true, isConnected: false, reconnectAttempts: 0,
    lastError: null, lastErrorMessage: null,
    sendInput: vi.fn(), sendResize: vi.fn(), terminate: vi.fn(),
    disconnect: vi.fn(() => { mocks.connection.isConnecting = false; mocks.connection.isConnected = false; }),
    reconnect: vi.fn(() => {
      Object.assign(mocks.connection, { isConnecting: true, isConnected: false, reconnectAttempts: 0, lastError: null, lastErrorMessage: null });
    }),
  };
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function render(patch: Partial<PtyConnection> = {}) {
  Object.assign(mocks.connection, patch);
  await act(async () => root.render(<I18nProvider><ServiceTerminal serviceId="api-service" name="api" enabled onConnected={mocks.connected} /></I18nProvider>));
  await act(async () => vi.dynamicImportSettled());
}
function button(label: string) {
  return [...host.querySelectorAll("button")].find((el) => el.textContent?.trim() === label);
}
async function connected() {
  await render({ isConnecting: false, isConnected: true, lastError: null, reconnectAttempts: 0 });
  await act(async () => {
    mocks.args!.onReady!({ sessionId: "session", resumeToken: "token", resumed: false });
    mocks.args!.onBytes(new TextEncoder().encode("api $ existing output\n"));
  });
}

describe("service terminal connection feedback", () => {
  it("lets the user cancel an attempt and reconnect explicitly", async () => {
    await render();
    expect(host.textContent).toContain(copy.connectingTitle);
    expect(mocks.args!.target).toEqual({ kind: "service", id: "api-service" });
    await act(async () => button(copy.cancel)!.click());
    expect(mocks.connection.disconnect).toHaveBeenCalledOnce();
    expect(host.textContent).toContain(copy.pausedTitle);
    expect(host.textContent).not.toContain(copy.connectingTitle);
    await act(async () => button(copy.reconnect)!.click());
    expect(mocks.connection.reconnect).toHaveBeenCalledOnce();
    expect(host.textContent).toContain(copy.connectingTitle);
  });

  it("keeps output through reconnect backoff and a terminal failure", async () => {
    await render();
    await connected();
    expect(mocks.connected).toHaveBeenCalledOnce();
    const output = host.querySelector("pre");
    expect(output?.textContent).toContain("existing output");
    await render({ isConnected: false, isConnecting: false, reconnectAttempts: 1, lastError: "transport", lastErrorMessage: "socket closed" });
    expect(host.textContent).toContain(copy.reconnectingTitle);
    expect(host.textContent).not.toContain(copy.errorTitle);
    expect(button(copy.cancel)).toBeDefined();
    await render({ lastError: "max_reconnects", lastErrorMessage: null });
    expect(host.textContent).toContain(copy.errors.maxReconnects);
    expect(button(copy.reconnect)).toBeDefined();
    expect(output?.isConnected).toBe(true);
    expect(output?.textContent).toContain("existing output");
    expect(mocks.dispose).not.toHaveBeenCalled();
    await act(async () => button(copy.reconnect)!.click());
    await connected();
    expect(host.textContent).toContain(copy.connected);
    expect(host.textContent).not.toContain(copy.errorTitle);
    expect(host.querySelector("pre")).toBe(output);
  });

  it("shows actionable copy with raw errors inside closed technical details", async () => {
    await render({ isConnecting: false, lastError: "ssh_connect", lastErrorMessage: "runtime bridge request failed (ETIMEDOUT)" });
    expect(host.textContent).toContain(copy.errors.connect);
    const details = host.querySelector("details");
    expect(details?.open).toBe(false);
    expect(details?.textContent).toContain("ETIMEDOUT");
    expect(button(copy.reconnect)).toBeDefined();
  });

  it("does not hide a definitive permission error behind a reconnect indicator", async () => {
    await render({ isConnecting: true, reconnectAttempts: 2, lastError: "ssh_auth", lastErrorMessage: "Denied" });
    expect(host.textContent).toContain(copy.errors.auth);
    expect(host.textContent).not.toContain(copy.reconnectingTitle);
    expect(button(copy.cancel)).toBeUndefined();
  });

  it("can pause during backoff without continuing to show reconnecting", async () => {
    await render({ isConnecting: false, reconnectAttempts: 2, lastError: "transport" });
    await act(async () => button(copy.cancel)!.click());
    expect(host.textContent).toContain(copy.pausedTitle);
    expect(host.textContent).not.toContain(copy.reconnectingTitle);
  });

  it("offers a new session after exit and does not discard previous output", async () => {
    await render();
    await connected();
    await act(async () => mocks.args!.onExit!(0));
    await render({ isConnected: false });
    expect(host.textContent).toContain(copy.closedTitle);
    expect(host.querySelector("details")?.textContent).toContain("Exit code 0");
    expect(host.querySelector("pre")?.textContent).toContain("existing output");
    await act(async () => button(copy.reconnect)!.click());
    expect(host.textContent).not.toContain(copy.closedTitle);
    expect(mocks.connection.reconnect).toHaveBeenCalledOnce();
  });
});
