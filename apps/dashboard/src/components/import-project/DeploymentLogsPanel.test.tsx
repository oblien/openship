// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Terminal } from "@xterm/xterm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { baseDictionary } from "@/i18n";
import { useLogTerminal } from "@/components/terminal/LogTerminalContext";
import { DeploymentLogsPanel } from "./DeploymentLogsPanel";

const mocks = vi.hoisted(() => ({
  copy: vi.fn(), toast: vi.fn(), search: vi.fn(), disposed: vi.fn(),
}));
vi.mock("@/components/i18n-provider", () => ({ useI18n: () => ({ t: baseDictionary }) }));
vi.mock("@/context/ToastContext", () => ({ useToast: () => ({ showToast: mocks.toast }) }));
vi.mock("@/lib/clipboard", () => ({ copyText: mocks.copy }));
vi.mock("@xterm/addon-search", () => ({
  SearchAddon: class {
    terminal!: Terminal & { id: string; lines: string[] };
    activate(terminal: typeof this.terminal) { this.terminal = terminal; }
    findNext(value: string) {
      mocks.search(this.terminal.id, "next", value);
      return this.terminal.lines.some(line => line.includes(value));
    }
    findPrevious(value: string) {
      mocks.search(this.terminal.id, "previous", value);
      return this.terminal.lines.some(line => line.includes(value));
    }
    clearDecorations() {}
    dispose() { mocks.disposed(this.terminal.id); }
  },
}));

function makeTerminal(id: string) {
  const listeners = new Set<() => void>();
  const lines = [`${id} first needle`, `${id} second needle`];
  const instance = {
    id, lines,
    buffer: { active: {
      get length() { return lines.length; },
      getLine: (index: number) => lines[index] === undefined ? undefined : {
        isWrapped: false,
        translateToString: () => lines[index],
      },
    } },
    clearSelection: vi.fn(),
    loadAddon: (addon: { activate: (terminal: unknown) => void }) => addon.activate(instance),
    onWriteParsed: (callback: () => void) => {
      listeners.add(callback);
      return { dispose: () => listeners.delete(callback) };
    },
  };
  return { terminal: instance as unknown as Terminal, lines, write: () => listeners.forEach(callback => callback()) };
}

function Surface({ terminal, active }: { terminal: Terminal; active: boolean }) {
  useLogTerminal(terminal, active);
  return null;
}

const copy = baseDictionary.projectDetail.logs;
let host: HTMLDivElement;
let root: Root;
let api: ReturnType<typeof makeTerminal>;
let web: ReturnType<typeof makeTerminal>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.copy.mockResolvedValue(undefined);
  api = makeTerminal("api");
  web = makeTerminal("web");
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function render(active: "api" | "web" | null = "api") {
  await act(async () => root.render(
    <DeploymentLogsPanel title="Deployment Logs">
      <Surface terminal={api.terminal} active={active === "api"} />
      <Surface terminal={web.terminal} active={active === "web"} />
    </DeploymentLogsPanel>,
  ));
}
function button(label: string) {
  return host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
}
async function query(value: string) {
  const input = host.querySelector("input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => vi.advanceTimersByTimeAsync(150));
}

describe("deployment log controls", () => {
  it("searches and copies only the visible service, disposing its search when the tab changes", async () => {
    await render();
    await query("needle");
    expect(mocks.search).toHaveBeenLastCalledWith("api", "next", "needle");
    await act(async () => button(copy.terminal.previousMatch).click());
    expect(mocks.search).toHaveBeenLastCalledWith("api", "previous", "needle");
    await act(async () => button(copy.actions.copy).click());
    expect(mocks.copy).toHaveBeenLastCalledWith(api.lines.join("\n"));
    expect(button(copy.actions.copied)).not.toBeNull();

    await render("web");
    await act(async () => vi.advanceTimersByTimeAsync(150));
    expect(mocks.disposed).toHaveBeenCalledWith("api");
    expect(mocks.search).toHaveBeenLastCalledWith("web", "next", "needle");
    expect(button(copy.actions.copied)).toBeNull();
    await act(async () => button(copy.actions.copy).click());
    expect(mocks.copy).toHaveBeenLastCalledWith(web.lines.join("\n"));

    await render(null);
    expect(button(copy.actions.copy).disabled).toBe(true);
    expect(host.querySelector("input")!.disabled).toBe(true);
  });

  it("finds a term that arrives later in the live output and supports Enter, Shift+Enter, and Escape", async () => {
    await render();
    await query("later");
    expect(button(copy.terminal.nextMatch).disabled).toBe(true);
    api.lines.push("later live output");
    await act(async () => api.write());
    await act(async () => vi.advanceTimersByTimeAsync(150));
    expect(button(copy.terminal.nextMatch).disabled).toBe(false);
    const input = host.querySelector("input")!;
    await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(mocks.search).toHaveBeenLastCalledWith("api", "next", "later");
    await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true })));
    expect(mocks.search).toHaveBeenLastCalledWith("api", "previous", "later");
    api.lines.splice(0);
    await act(async () => button(copy.terminal.nextMatch).click());
    expect(button(copy.terminal.nextMatch).disabled).toBe(true);
    api.lines.push("later after the buffer was cleared");
    await act(async () => api.write());
    await act(async () => vi.advanceTimersByTimeAsync(150));
    expect(button(copy.terminal.nextMatch).disabled).toBe(false);
    await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(input.value).toBe("");
    expect(api.terminal.clearSelection).toHaveBeenCalled();
  });

  it("reports clipboard failure without claiming the logs were copied", async () => {
    await render();
    await act(async () => button(copy.actions.copy).click());
    expect(button(copy.actions.copied)).not.toBeNull();
    mocks.copy.mockRejectedValueOnce(new Error("Clipboard denied"));
    await act(async () => button(copy.actions.copied).click());
    expect(mocks.toast).toHaveBeenCalledWith(baseDictionary.projectSettings.advanced.projectMenu.copyFailed, "error");
    expect(button(copy.actions.copied)).toBeNull();
  });

  it("does not apply a delayed copy confirmation to a different service", async () => {
    let finish!: () => void;
    mocks.copy.mockReturnValueOnce(new Promise<void>(resolve => { finish = resolve; }));
    await render();
    await act(async () => button(copy.actions.copy).click());
    await render("web");
    await act(async () => finish());
    expect(button(copy.actions.copied)).toBeNull();
  });
});
