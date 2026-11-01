// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nProvider } from "@/components/i18n-provider";
import { ToastProvider } from "@/components/toast";
import { ModalProvider } from "@/context/ModalContext";
import { DashboardProviders } from "../providers";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const searchParams = new URLSearchParams();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, back: () => {}, refresh: () => {} }),
  usePathname: () => "/servers",
  useSearchParams: () => searchParams,
}));

const SERVER = {
  id: "srv_1",
  name: "prod-1",
  sshHost: "203.0.113.10",
  sshPort: 22,
  sshUser: "root",
  sshAuthMethod: "key",
  country: null,
  isLocal: false,
  projectCount: 1,
};
const PREVIEW = {
  serverId: SERVER.id,
  serverName: SERVER.name,
  sshHost: SERVER.sshHost,
  isLocal: false,
  workloads: [
    {
      id: "proj_1",
      name: "web",
      slug: "web",
      environmentName: null,
      environmentSlug: null,
      groupName: null,
      isApp: false,
      isControlPlane: false,
      activeDeploymentId: "dep_1",
    },
  ],
  projectCount: 1,
  appCount: 0,
  reachable: false,
  alsoRemoved: { mailConfigured: false, tunnels: 0, githubRegistration: false },
  alsoUnbound: { backupDestinations: 0 },
};
const REMOVED = {
  ok: true,
  serverRemoved: true,
  destroyOnSource: false,
  removed: 1,
  workloads: [{ id: "proj_1", name: "web", ok: true }],
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
let preview: unknown;
let deletion: () => Response | Promise<Response>;
let deleted: URL[];
let container: HTMLDivElement;
let root: Root | undefined;
let errors: unknown[];

beforeEach(() => {
  errors = [];
  deleted = [];
  preview = PREVIEW;
  deletion = () => json(REMOVED);
  let serverRemoved = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = new URL(String(typeof input === "string" ? input : (input as Request)?.url ?? input));
      if (init?.method === "DELETE") {
        deleted.push(url);
        const response = await deletion();
        const result = await response.clone().json();
        if (response.ok && result.serverRemoved === true) serverRemoved = true;
        return response;
      }
      if (url.pathname.endsWith("/deletion-preview")) return json({ ok: true, preview });
      if (url.pathname.endsWith("/reachability"))
        return json({ reachable: false, code: "unreachable" });
      // Connection reconciliation may refresh the list after a deletion. Model
      // the committed server state instead of resurrecting the deleted fixture.
      if (url.pathname.endsWith("/system/servers")) return json(serverRemoved ? [] : [SERVER]);
      // Deliberately malformed infrastructure responses: these must not disable removal.
      return json({});
    }),
  );
  container = document.createElement("div");
  document.body.appendChild(container);
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
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
        <DashboardProviders
          selfHosted
          deployMode="docker"
          authMode="local"
          cloudAuthUrl=""
          cloudApiUrl=""
        >
          <ToastProvider>
            <ModalProvider>
              <ServersPage />
            </ModalProvider>
          </ToastProvider>
        </DashboardProviders>
      </I18nProvider>,
    );
  });
}
async function click(element: Element | null) {
  expect(element).not.toBeNull();
  await act(async () => (element as HTMLElement).click());
}
function button(text: string, parent: ParentNode = document.body) {
  return [...parent.querySelectorAll("button")].find(
    (el) => el.textContent?.trim().toLowerCase() === text.toLowerCase(),
  )!;
}
function dialog() {
  return document.querySelector('[role="dialog"]')!;
}
async function openRemoval() {
  await mountList();
  expect(errors).toEqual([]);
  await click(container.querySelector('button[aria-label="prod-1: Remove Server"]'));
  await click(button("Remove server"));
  expect(dialog()).not.toBeNull();
}
async function typeConfirmation(name = SERVER.name) {
  const input = dialog().querySelector("input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, name);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("servers list removal", () => {
  it("requires the exact name and keeps an unreachable server's workloads running", async () => {
    await openRemoval();
    expect(dialog().textContent).toContain("web");
    expect(dialog().textContent).toContain("isn't responding");
    expect(dialog().querySelector('[role="checkbox"]')).toBeNull();
    expect(button("Remove server", dialog()).disabled).toBe(true);
    await typeConfirmation("another-server");
    expect(button("Remove server", dialog()).disabled).toBe(true);
    expect(deleted).toEqual([]);
    await typeConfirmation();
    await click(button("Remove server", dialog()));
    expect(deleted.map((url) => url.pathname)).toEqual(["/api/system/servers/srv_1"]);
    expect(deleted[0]!.search).toBe("");
    expect(dialog()).toBeNull();
    expect(container.querySelector('a[href="/servers/srv_1"]')).toBeNull();
    expect(document.body.textContent).toContain("keeps running");
    expect(errors).toEqual([]);
  });

  it("handles a malformed preview without claiming there are no workloads or offering destruction", async () => {
    preview = { workloads: [null], reachable: true };
    await openRemoval();
    expect(dialog().textContent).toContain("couldn't be checked");
    expect(dialog().textContent).not.toContain("Nothing is deployed");
    expect(dialog().querySelector('[role="checkbox"]')).toBeNull();
    await typeConfirmation();
    await click(button("Remove server", dialog()));
    expect(deleted[0]!.search).toBe("");
    expect(errors).toEqual([]);
  });

  it("preserves the row and failure details after partial teardown, then permits retry", async () => {
    preview = { ...PREVIEW, reachable: true };
    await openRemoval();
    const checkbox = dialog().querySelector('[role="checkbox"]')!;
    expect(checkbox.getAttribute("aria-checked")).toBe("false");
    await click(checkbox);
    await typeConfirmation();
    let finish!: (response: Response) => void;
    deletion = () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      });
    const confirm = button("Remove and delete workloads", dialog());
    await act(async () => {
      confirm.click();
      confirm.click();
    });
    expect(deleted).toHaveLength(1);
    expect(deleted[0]!.searchParams.get("destroyOnSource")).toBe("true");
    expect(confirm.disabled).toBe(true);
    expect(button("Cancel", dialog()).disabled).toBe(true);
    await act(async () =>
      finish(
        json(
          {
            ok: false,
            serverRemoved: false,
            destroyOnSource: true,
            code: "SERVER_WORKLOAD_TEARDOWN_FAILED",
            error: "Cleanup failed",
            workloads: [{ id: "proj_1", name: "web", ok: false, error: "container still running" }],
          },
          409,
        ),
      ),
    );
    expect(dialog().textContent).toContain("container still running");
    expect(container.querySelector('a[href="/servers/srv_1"]')).not.toBeNull();
    deletion = () => json({ ...REMOVED, destroyOnSource: true });
    await click(button("Remove and delete workloads", dialog()));
    expect(deleted).toHaveLength(2);
    expect(dialog()).toBeNull();
    expect(document.body.textContent).toContain("deleted from the machine");
    expect(errors).toEqual([]);
  });

  it("keeps a malformed deletion response retryable without falsely removing the row", async () => {
    await openRemoval();
    await typeConfirmation();
    deletion = () => json({ success: true });
    await click(button("Remove server", dialog()));
    expect(dialog()).not.toBeNull();
    expect(container.querySelector('a[href="/servers/srv_1"]')).not.toBeNull();
    expect(document.body.textContent).toContain("invalid response");
    expect(button("Remove server", dialog()).disabled).toBe(false);
    expect(errors).toEqual([]);
  });

  it("cancels without sending a delete request", async () => {
    await openRemoval();
    await typeConfirmation();
    await click(button("Cancel", dialog()));
    expect(deleted).toEqual([]);
    expect(dialog()).toBeNull();
    expect(container.querySelector('a[href="/servers/srv_1"]')).not.toBeNull();
  });
});
