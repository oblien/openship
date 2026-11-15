// @vitest-environment happy-dom
/**
 * The Build cache card sends exactly the budget the operator chose: automatic saves `null`
 * straight away, a custom size is sent in bytes only after Save, and an invalid size is never sent.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nProvider } from "@/components/i18n-provider";
import { ToastProvider } from "@/components/toast";
import type { ServerInfo } from "@/lib/api/system";
import { BuildCacheCard } from "./build-cache-card";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const GIB = 1024 ** 3;
let container: HTMLDivElement;
let root: Root | undefined;
let sent: Array<Record<string, unknown>>;

function server(buildCacheBudgetBytes: number | null): ServerInfo {
  return { id: "srv_1", name: "builder", buildCacheBudgetBytes } as unknown as ServerInfo;
}

beforeEach(() => {
  sent = [];
  container = document.createElement("div");
  document.body.appendChild(container);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(typeof input === "string" ? input : ((input as Request)?.url ?? input));
      if (/system\/servers\/srv_1$/.test(url) && init?.method === "PATCH") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        sent.push(body);
        return new Response(JSON.stringify(server(body.buildCacheBudgetBytes as number | null)), {
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("{}", { headers: { "content-type": "application/json" } });
    }),
  );
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = undefined;
  container.remove();
  vi.unstubAllGlobals();
});

async function mount(initial: number | null) {
  const changed = vi.fn();
  await act(async () => {
    root = createRoot(container);
    root.render(
      <I18nProvider>
        <ToastProvider>
          <BuildCacheCard server={server(initial)} onChanged={changed} />
        </ToastProvider>
      </I18nProvider>,
    );
  });
  return changed;
}

async function settle() {
  for (let i = 0; i < 3; i++) await act(async () => new Promise((r) => setTimeout(r, 0)));
}

async function choose(label: string) {
  await act(async () =>
    container.querySelector<HTMLButtonElement>("[aria-haspopup='listbox']")!.click(),
  );
  const option = [...document.querySelectorAll<HTMLElement>("[role='option']")].find(
    (node) => node.textContent?.trim() === label,
  );
  await act(async () => option!.click());
}

async function type(value: string) {
  const input = container.querySelector<HTMLInputElement>("input")!;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const saveButton = () =>
  [...container.querySelectorAll<HTMLButtonElement>("button[type='submit']")][0]!;

describe("BuildCacheCard", () => {
  it("saves a custom size in bytes only when Save is pressed", async () => {
    const changed = await mount(null);
    await choose("Custom");
    expect(sent).toEqual([]);
    await type("24");
    await act(async () => saveButton().click());
    await settle();
    expect(sent).toEqual([{ buildCacheBudgetBytes: 24 * GIB }]);
    expect(changed).toHaveBeenCalledWith(
      expect.objectContaining({ buildCacheBudgetBytes: 24 * GIB }),
    );
  });

  it("returns to automatic straight away by sending null", async () => {
    await mount(24 * GIB);
    expect(container.querySelector<HTMLInputElement>("input")!.value).toBe("24");
    await choose("Automatic");
    await settle();
    expect(sent).toEqual([{ buildCacheBudgetBytes: null }]);
  });

  it("explains an invalid size and never sends it", async () => {
    await mount(null);
    await choose("Custom");
    await type("0.5");
    expect(saveButton().disabled).toBe(true);
    expect(container.querySelector("[role='alert']")?.textContent).toContain("1 to 65536");
    await act(async () => saveButton().click());
    expect(sent).toEqual([]);
  });
});
