// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { MailSetupStatus } from "@/lib/api/mail";
import { I18nProvider } from "@/components/i18n-provider";

const h = vi.hoisted(() => ({
  selfHosted: true,
  deployMode: "server",
  query: "serverId=one",
  router: { replace: vi.fn() },
  status: vi.fn(),
  registry: vi.fn(),
  server: vi.fn(),
  servers: vi.fn(),
  mutation: vi.fn(),
  modal: vi.fn(),
  toast: vi.fn(),
}));
vi.mock("@/context/PlatformContext", () => ({ usePlatform: () => ({ selfHosted: h.selfHosted, deployMode: h.deployMode }) }));
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(h.query),
  useRouter: () => h.router,
  usePathname: () => "/emails",
}));
vi.mock("@/lib/api", async () => ({
  ...(await import("@/lib/api/client")),
  mailApi: {
    getStatus: h.status,
    listMailServers: h.registry,
    streamSetup: h.mutation,
    cancelSetup: h.mutation,
    resetSetup: h.mutation,
    forget: h.mutation,
  },
  mailAdminApi: {},
  systemApi: { getServerById: h.server, listServers: h.servers },
}));
vi.mock("@/context/ModalContext", () => ({
  useModal: () => ({ showModal: h.modal, hideModal: h.modal }),
}));
vi.mock("@/context/ToastContext", () => ({ useToast: () => ({ showToast: h.toast }) }));
vi.mock("../_lib/mail-section", () => ({
  getMailSectionHeading: () => null,
  useMailRailOwnsTabs: () => false,
}));
// Exercise the console's actual loading/selection/recovery flow; the child
// editors don't need their own requests or interactive setup in these tests.
vi.mock("./mail-setup-form", () => ({ MailSetupForm: () => <div data-testid="setup" /> }));
vi.mock("./mail-progress", () => ({ MailProgress: () => <div data-testid="progress" /> }));
vi.mock("./mail-sidebar", () => ({ MailSidebar: () => null }));
vi.mock("./mail-server-list", () => ({ MailServerList: () => <div data-testid="list" /> }));
vi.mock("./admin/admin-panel", () => ({
  MailAdminPanel: ({
    serverId,
    status,
    onRefresh,
  }: {
    serverId: string;
    status: MailSetupStatus;
    onRefresh: () => void;
  }) => (
    <div data-testid="admin" data-server={serverId} data-engine={String(status.engine?.running)}>
      {status.domain}
      <button onClick={onRefresh}>Refresh test status</button>
    </div>
  ),
}));
import { MailConsole } from "./mail-console";

const status = (id = "one") => ({
  serverId: id,
  active: false,
  domain: `${id}.example.com`,
  steps: [{ id: 1, status: "completed" }],
  engine: { flavor: "container", running: true },
});
const registry = (id = "one") => ({
  id,
  domain: `${id}.example.com`,
  name: id,
  completed: true,
  active: false,
});
let node: HTMLDivElement;
let root: Root;
const admin = () => node.querySelector('[data-testid="admin"]');
const setup = () => node.querySelector('[data-testid="setup"]');
async function render() {
  await act(async () =>
    root.render(
      <I18nProvider>
        <MailConsole />
      </I18nProvider>,
    ),
  );
}
async function click(label: string) {
  const button = [...node.querySelectorAll("button")].find((element) =>
    element.textContent?.includes(label),
  );
  expect(button, label).toBeDefined();
  await act(async () => button!.click());
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  h.selfHosted = true;
  h.deployMode = "server";
  h.query = "serverId=one";
  h.status.mockReset().mockImplementation(async (id) => status(id));
  h.registry.mockReset().mockResolvedValue({ servers: [registry()] });
  h.server.mockReset().mockImplementation(async (id) => ({ id, name: id, sshHost: "192.0.2.1" }));
  h.servers.mockReset().mockResolvedValue([]);
  node = document.createElement("div");
  document.body.appendChild(node);
  root = createRoot(node);
});
afterEach(async () => {
  await act(async () => root.unmount());
  expect(h.mutation).not.toHaveBeenCalled();
  expect(h.modal).not.toHaveBeenCalled();
  node.remove();
  vi.unstubAllGlobals();
});

it("offers a status retry after an unavailable first read, never a fresh setup", async () => {
  h.status.mockRejectedValueOnce(new Error("connect ENETUNREACH 192.0.2.1:22"));
  await render();
  expect(node.textContent).toContain("Mail status unavailable");
  expect(admin()).toBeNull();
  expect(setup()).toBeNull();
  await click("Retry status");
  expect(node.textContent).not.toContain("Mail status unavailable");
  expect(admin()?.getAttribute("data-server")).toBe("one");
});

it("keeps the same server's saved details, removes stale health, and recovers on retry", async () => {
  await render();
  h.status.mockRejectedValueOnce(new Error("Connection lost"));
  await click("Refresh test status");
  expect(node.textContent).toContain("Mail status unavailable");
  expect(admin()?.textContent).toContain("one.example.com");
  expect(admin()?.getAttribute("data-engine")).toBe("undefined");
  expect(setup()).toBeNull();
  await click("Retry status");
  expect(admin()?.getAttribute("data-engine")).toBe("true");
  expect(node.textContent).not.toContain("Mail status unavailable");
});

it("does not infer an empty registry from a failed list and can retry initialization", async () => {
  h.query = "";
  h.registry.mockRejectedValueOnce(new Error("Failed to fetch"));
  await render();
  expect(node.textContent).toContain("Mail status unavailable");
  expect(setup()).toBeNull();
  expect(h.status).not.toHaveBeenCalled();
  await click("Retry status");
  expect(admin()?.getAttribute("data-server")).toBe("one");
  expect(h.status).toHaveBeenCalledExactlyOnceWith("one");
});

it("retries a failed default-server lookup instead of leaving the console stuck", async () => {
  h.query = "";
  h.server.mockRejectedValueOnce(new Error("Connection lost"));
  await render();
  expect(node.textContent).toContain("Mail status unavailable");
  expect(setup()).toBeNull();
  await click("Retry status");
  expect(admin()?.getAttribute("data-server")).toBe("one");
});

it("discards an old server response when the newly selected server cannot be loaded", async () => {
  let completeOld!: (value: ReturnType<typeof status>) => void;
  h.status.mockReturnValueOnce(
    new Promise((resolve) => {
      completeOld = resolve;
    }),
  );
  await render();
  h.query = "serverId=two";
  h.server.mockRejectedValueOnce(new Error("Connection lost"));
  await render();
  await act(async () => completeOld(status("one")));
  expect(node.textContent).toContain("Mail status unavailable");
  expect(admin()).toBeNull();
  expect(setup()).toBeNull();
  await click("Retry status");
  expect(admin()?.getAttribute("data-server")).toBe("two");
  expect(admin()?.textContent).toContain("two.example.com");
  expect(node.textContent).not.toContain("one.example.com");
});


it("offers the generic Cloud mail client without loading or provisioning mail servers", async () => {
  h.selfHosted = false;
  h.deployMode = "cloud";
  await render();
  expect(node.textContent).toContain("Coming soon");
  expect(node.textContent).toContain("do not provision a mail server");
  expect(node.querySelector('a[href="/apps/new/webmail"]')?.textContent).toContain("Connect existing mail server");
  expect(h.registry).not.toHaveBeenCalled();
  expect(h.status).not.toHaveBeenCalled();
  expect(setup()).toBeNull();
});

it("keeps the desktop mail console available", async () => {
  h.selfHosted = false;
  h.deployMode = "desktop";
  await render();
  expect(node.textContent).not.toContain("Coming soon");
  expect(h.registry).toHaveBeenCalled();
});
