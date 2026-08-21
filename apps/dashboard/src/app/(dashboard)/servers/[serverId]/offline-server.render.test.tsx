// @vitest-environment happy-dom
/**
 * The server detail page must survive an UNREACHABLE server.
 *
 * Reported symptom: the (dashboard) error boundary ("This page hit an error") on
 * every visit to an offline server's id page — which is also the only screen
 * carrying "Remove server", so a box that had gone down could not be deleted from
 * the UI at all.
 *
 * This mounts the REAL page inside the REAL (dashboard) provider stack with a real
 * DOM, and stubs only the network. Every component the page mounts for the offline
 * state runs its own code: the connection banner, the overview tab with no stats,
 * the connection card, and the always-mounted migrations tab (which mounts the
 * whole migration wizard whenever the server has no runs). A throw in any of them
 * fails here instead of reaching an operator.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nProvider } from "@/components/i18n-provider";
import { ToastProvider } from "@/components/toast";
import { ModalProvider } from "@/context/ModalContext";
// The REAL (dashboard) provider stack, so the tree under test sees exactly the
// contexts it sees in the app — a provider missing only here would show up as a
// crash that no user can hit.
import { DashboardProviders } from "../../providers";

// React 19 requires this flag before act() will drive updates.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let searchParams = new URLSearchParams();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, back: () => {}, refresh: () => {} }),
  usePathname: () => "/servers/srv_1",
  useSearchParams: () => searchParams,
}));

// Streams are not what's under test and happy-dom has no streaming body. The
// page's own null/empty handling stays real.
vi.mock("@/hooks/useMonitorStream", () => ({
  useMonitorStream: () => ({
    stats: null,
    isConnected: false,
    error: null,
    reconnect: () => {},
    disconnect: () => {},
  }),
}));
vi.mock("@/hooks/useSetupStream", () => ({
  useSetupStream: () => ({
    startInstall: async () => {},
    attachToSession: async () => {},
    disconnect: () => {},
    isConnected: false,
    isConnecting: false,
    components: [],
    logs: [],
    pendingPrompt: null,
    respondToPrompt: async () => {},
    isDone: false,
    finalStatus: null,
    error: null,
  }),
}));

/** The row as the API returns it: present in the DB, unreachable over SSH. */
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

/**
 * The failure shapes POST system/check really answers with for a box that is not
 * answering — see server-check.controller.ts. Each is a different banner path, and
 * the host-channel ones are what a containerized self-hosted install actually hits.
 */
const CHECK_FAILURES: Array<{ name: string; status: number; body: unknown }> = [
  {
    name: "unreachable (ETIMEDOUT)",
    status: 502,
    body: { error: "connection_failed", message: "connect ETIMEDOUT 203.0.113.10:22" },
  },
  {
    name: "auth rejected",
    status: 400,
    body: { error: "auth_failed", message: "All configured authentication methods failed" },
  },
  {
    name: "no server row / misconfigured",
    status: 400,
    body: { error: "no_server", message: "Server is not configured" },
  },
  {
    name: "host channel blocked (containerized)",
    status: 502,
    body: {
      error: "host_channel_blocked",
      code: "host_channel_blocked",
      message: "connect ETIMEDOUT 172.18.0.1:22",
      target: "172.18.0.1:22",
      hint: "The host firewall is dropping traffic from the bridge network.",
      rule: "sudo ufw allow from 172.18.0.0/16 to any port 22 proto tcp",
      channel: "blocked",
    },
  },
  {
    name: "host channel never provisioned",
    status: 502,
    body: {
      error: "host_channel_blocked",
      code: "host_channel_blocked",
      message: "No host SSH endpoint is configured",
      target: null,
      intendedTarget: "172.18.0.1:22",
      hint: null,
      rule: null,
      channel: "not_configured",
    },
  },
  // Defensive: a proxy/gateway between the dashboard and the API can answer with
  // something that is not the API's JSON at all. The page must still render.
  { name: "opaque gateway error", status: 502, body: "<html>502 Bad Gateway</html>" },
];

function stubFetch(checkFailure: { status: number; body: unknown }) {
  return vi.fn(async (input: unknown) => {
    const url = String(
      typeof input === "string" ? input : (input as Request)?.url ?? input,
    );
    const json = (body: unknown, status = 200) =>
      typeof body === "string"
        ? new Response(body, { status, headers: { "content-type": "text/html" } })
        : new Response(JSON.stringify(body), {
            status,
            headers: { "content-type": "application/json" },
          });

    if (url.includes("system/check")) return json(checkFailure.body, checkFailure.status);
    if (/system\/servers\/srv_1(\?|$)/.test(url)) return json(OFFLINE_SERVER);
    if (url.includes("system/servers")) return json([OFFLINE_SERVER]);
    if (url.includes("system/install/session")) return json({ active: false });
    if (url.includes("migration")) return json({ runs: [] });
    // Every other call the mounted subtree makes: answer, don't hang.
    return json({});
  });
}

let container: HTMLDivElement;
let root: Root | undefined;
let errors: unknown[] = [];

beforeEach(() => {
  errors = [];
  searchParams = new URLSearchParams();
  container = document.createElement("div");
  document.body.appendChild(container);
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = undefined;
  container.remove();
  vi.unstubAllGlobals();
});

async function mountOfflineServer(checkFailure: { status: number; body: unknown }) {
  vi.stubGlobal("fetch", stubFetch(checkFailure));
  // Imported lazily so the vi.mock factories above are installed first.
  const { default: ServerDetailPage } = await import("./page");

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
              <ServerDetailPage params={Promise.resolve({ serverId: "srv_1" })} />
            </ModalProvider>
          </ToastProvider>
        </DashboardProviders>
      </I18nProvider>,
    );
  });
  // Let the row load + the failing health check settle.
  for (let i = 0; i < 3; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
  return container.textContent ?? "";
}

describe("server detail page with an unreachable server", () => {
  for (const failure of CHECK_FAILURES) {
    it(`renders rather than crashing: ${failure.name}`, async () => {
      const text = await mountOfflineServer(failure);

      expect(errors).toEqual([]);
      // Proof we got past `loading` AND past the not-found branch — i.e. this is
      // the real detail page, the one that carries "Remove server".
      expect(text).toContain("prod-1");
    });
  }

  /**
   * The actual regression: the page is the ONLY place a server can be deleted
   * from, so the remove action has to be reachable while the box is down.
   */
  it("exposes the remove action for a server that is down", async () => {
    await mountOfflineServer(CHECK_FAILURES[0]!);
    expect(errors).toEqual([]);

    // "Remove server" lives behind the ⋯ overflow menu in the header. Click each
    // icon-only header button until the menu opens — which button index carries it
    // is layout detail this test shouldn't pin.
    const iconOnly = Array.from(container.querySelectorAll("button")).filter(
      (b) => b.querySelector("svg") && !b.textContent?.trim(),
    );
    expect(iconOnly.length, "header should render icon-only buttons").toBeGreaterThan(0);

    for (const button of iconOnly) {
      await act(async () => {
        button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      if (container.textContent?.toLowerCase().includes("remove server")) break;
    }

    expect(errors).toEqual([]);
    expect(container.textContent?.toLowerCase()).toContain("remove server");
  });

  /**
   * ?tab= is persisted by changeTab, so a reload lands back on whatever tab the
   * operator was last on. Each one has to survive the server being down too —
   * these mount entirely different subtrees (component/module update cards, the
   * terminal, exposed ports) against a host that cannot answer.
   */
  for (const tab of ["components", "migrations", "security", "terminal", "github"]) {
    it(`survives ?tab=${tab} while the server is down`, async () => {
      searchParams = new URLSearchParams({ tab });
      const text = await mountOfflineServer(CHECK_FAILURES[0]!);

      expect(errors).toEqual([]);
      expect(text).toContain("prod-1");
    });
  }
});
