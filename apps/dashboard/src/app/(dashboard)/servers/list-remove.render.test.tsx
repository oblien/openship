// @vitest-environment happy-dom
/**
 * A server must be removable from the LIST, not only from its detail page.
 *
 * Deleting used to be reachable from exactly one screen — the server detail page's
 * ⋯ menu — so anything that stopped that page rendering also made the server
 * impossible to remove. An offline box is the case that matters: it is both the
 * one you most want to delete and the one whose detail page does the most work.
 *
 * The delete call itself is record-only (no SSH), so this asserts the affordance
 * exists and fires for a server that is NOT reachable.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nProvider } from "@/components/i18n-provider";
import { ToastProvider } from "@/components/toast";
import { ModalProvider } from "@/context/ModalContext";
import { DashboardProviders } from "../providers";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, back: () => {}, refresh: () => {} }),
  usePathname: () => "/servers",
  useSearchParams: () => new URLSearchParams(),
}));

const OFFLINE_SERVER = {
  id: "srv_1",
  name: "prod-1",
  sshHost: "203.0.113.10",
  sshPort: 22,
  sshUser: "root",
  sshAuthMethod: "key",
  country: null,
  isLocal: false,
};

/** Every DELETE the page issued, so the test can prove the action reached the API. */
let deleted: string[] = [];

function stubFetch() {
  return vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(typeof input === "string" ? input : (input as Request)?.url ?? input);
    const method = (init?.method ?? (input as Request)?.method ?? "GET").toUpperCase();
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });

    const del = url.match(/system\/servers\/([^/?]+)$/);
    if (method === "DELETE" && del) {
      deleted.push(del[1]!);
      return json({ success: true });
    }
    if (url.includes("system/servers") && url.includes("reachability")) {
      // The box is down — the state this whole test is about.
      return json({ reachable: false, code: "unreachable" }, 200);
    }
    if (/system\/servers(\?|$)/.test(url)) return json([OFFLINE_SERVER]);
    return json({});
  });
}

let container: HTMLDivElement;
let root: Root | undefined;
const errors: unknown[] = [];

beforeEach(() => {
  errors.length = 0;
  deleted = [];
  vi.stubGlobal("fetch", stubFetch());
  container = document.createElement("div");
  document.body.appendChild(container);
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = undefined;
  container.remove();
  vi.unstubAllGlobals();
});

async function mountList() {
  const { default: ServersPage } = await import("./page");
  await act(async () => {
    root = createRoot(container, {
      onUncaughtError: (e) => errors.push(e),
      onCaughtError: (e) => errors.push(e),
    });
    root.render(
      <I18nProvider>
        <DashboardProviders selfHosted deployMode="docker" authMode="local" cloudAuthUrl="" cloudApiUrl="">
          <ToastProvider>
            <ModalProvider>
              <ServersPage />
            </ModalProvider>
          </ToastProvider>
        </DashboardProviders>
      </I18nProvider>,
    );
  });
  for (let i = 0; i < 3; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

/** Click through every button whose text matches, until `done()` reports success. */
async function clickUntil(match: RegExp, done: () => boolean) {
  for (const b of Array.from(document.body.querySelectorAll("button"))) {
    if (!match.test((b.textContent ?? "").toLowerCase())) continue;
    await act(async () => {
      b.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    if (done()) return true;
  }
  return done();
}

describe("servers list", () => {
  it("offers a remove action for an unreachable server, and it deletes", async () => {
    await mountList();
    expect(errors).toEqual([]);
    expect(container.textContent).toContain("prod-1");

    // Open the row's ⋯ menu (icon-only button inside the row).
    const iconOnly = Array.from(container.querySelectorAll("button")).filter(
      (b) => b.querySelector("svg") && !b.textContent?.trim(),
    );
    let menuOpened = false;
    for (const b of iconOnly) {
      await act(async () => {
        b.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      if (/remove server/i.test(document.body.textContent ?? "")) {
        menuOpened = true;
        break;
      }
    }
    expect(menuOpened, "row ⋯ menu should expose Remove Server").toBe(true);

    // Remove → confirm. The modal renders in a portal, so search the document.
    await clickUntil(/remove server/, () => /are you sure/i.test(document.body.textContent ?? ""));
    await clickUntil(/^remove$/, () => deleted.length > 0);

    expect(errors).toEqual([]);
    expect(deleted).toEqual(["srv_1"]);
  });
});
