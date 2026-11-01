// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getCredentialProvider } from "@repo/core";
import { I18nProvider } from "@/components/i18n-provider";
import { IngressConnectForm } from "./IngressConnectForm";
import { ServerIngressCard } from "./ServerIngressCard";
import { DomainIngressMenu } from "./DomainIngressSettings";
const h = vi.hoisted(() => ({
  org: "org",
  list: vi.fn(),
  discover: vi.fn(),
  connect: vi.fn(),
  domain: vi.fn(),
  setDomain: vi.fn(),
  providers: vi.fn(),
  credentials: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  role: vi.fn(),
}));
vi.mock("@/lib/auth-client", () => ({
  useSession: () => ({ data: { user: { id: "owner" }, session: { activeOrganizationId: h.org } } }),
  authClient: { organization: { getActiveMemberRole: h.role } },
}));
vi.mock("@/lib/api/ingress", () => ({ ingressApi: h }));
vi.mock("@/lib/api/credentials", () => ({
  credentialsApi: {
    providers: h.providers,
    list: h.credentials,
    create: h.create,
    update: h.update,
  },
}));
vi.mock("@/context/ToastContext", () => ({ useToast: () => ({ showToast: vi.fn() }) }));
const connection = {
  id: "igc_one",
  serverId: "server",
  credentialId: "credential",
  accountId: "account",
  tunnelId: "tunnel",
  name: "Existing",
  connector: "existing",
  status: "ready",
  defaultAccessPolicyId: "policy",
  defaultForDomains: true,
  error: null,
};
const saved = {
  id: "credential",
  provider: "cloudflare",
  name: "Home",
  status: "active",
  publicFields: {},
  secretsMasked: { apiToken: "********" },
  selector: null,
};
let host: HTMLDivElement, root: Root;
async function flush() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 5));
  });
}
async function render(node: ReactNode) {
  await act(async () => root.render(<I18nProvider>{node}</I18nProvider>));
  await flush();
}
function button(text: string, scope: ParentNode = document) {
  const b = [...scope.querySelectorAll<HTMLButtonElement>("button")].find(
    (b) => b.textContent?.trim() === text,
  );
  if (!b) throw new Error(`Missing ${text}: ${scope.textContent}`);
  return b;
}
async function click(text: string, scope: ParentNode = document) {
  await act(async () => button(text, scope).click());
  await flush();
}
async function select(label: string, option: string) {
  const l = [...document.querySelectorAll("label")].find((e) => e.textContent === label)!;
  await act(async () => document.getElementById(l.htmlFor)!.click());
  await flush();
  const o = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((e) =>
    e.textContent?.includes(option),
  )!;
  await act(async () => o.click());
  await flush();
}
beforeEach(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  h.org = "org";
  vi.clearAllMocks();
  localStorage.clear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  h.role.mockResolvedValue({ data: { role: "owner" } });
  h.providers.mockResolvedValue({ data: [getCredentialProvider("cloudflare")] });
  h.credentials.mockResolvedValue({ data: [saved] });
  h.list.mockResolvedValue([]);
  h.domain.mockResolvedValue(null);
  h.setDomain.mockResolvedValue(null);
  h.discover.mockResolvedValue({
    accounts: [{ id: "account", name: "Personal account" }],
    tunnels: [{ id: "tunnel", name: "Existing", remote: true, status: "healthy" }],
    policies: [{ id: "policy", name: "My team", decision: "allow" }],
    policiesError: null,
  });
  h.connect.mockResolvedValue({ ...connection, status: "pending" });
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  document.body.replaceChildren();
});
describe("Cloudflare setup UI", () => {
  it("explains incomplete settings and connects with saved credential IDs", async () => {
    const done = vi.fn();
    await render(<IngressConnectForm serverId="server" onClose={() => {}} onSaved={done} />);
    expect(button("Connect tunnel").disabled).toBe(true);
    expect(host.textContent).toContain("Complete the required settings");
    await select("Cloudflare credential", "Home");
    await select("Cloudflare account", "Personal account");
    await select("Named tunnel", "Existing");
    expect(button("Connect tunnel").disabled).toBe(false);
    await click("Connect tunnel");
    expect(h.connect).toHaveBeenCalledWith(
      expect.objectContaining({
        serverId: "server",
        credentialId: "credential",
        accountId: "account",
        tunnelId: "tunnel",
        connector: "existing",
        defaultForDomains: true,
      }),
    );
    expect(JSON.stringify(h.connect.mock.calls)).not.toContain("apiToken");
    expect(done).toHaveBeenCalledOnce();
  });
  it("offers the shared inline credential form with tunnel permissions", async () => {
    h.credentials.mockResolvedValue({ data: [] });
    await render(<IngressConnectForm serverId="server" onClose={() => {}} onSaved={() => {}} />);
    const l = [...document.querySelectorAll("label")].find(
      (e) => e.textContent === "Cloudflare credential",
    )!;
    await act(async () => document.getElementById(l.htmlFor)!.click());
    await flush();
    await click("Add credential");
    expect(host.querySelector('input[type="password"]')).not.toBeNull();
    expect(host.textContent).toContain("Cloudflare Tunnel Edit");
    expect(h.connect).not.toHaveBeenCalled();
  });
  it("keeps failed reads distinct from an empty connection", async () => {
    h.list.mockRejectedValueOnce(new Error("Cannot load connections"));
    await render(<ServerIngressCard serverId="server" />);
    expect(host.textContent).toContain("Status unavailable");
    expect(host.textContent).not.toContain("Connect a named tunnel");
    await click("Refresh status");
    expect(host.textContent).toContain("Connect a named tunnel");
  });
  it("does not re-enable Access on an explicitly unprotected hostname", async () => {
    const editRoute = vi.fn();
    h.list.mockResolvedValue([connection]);
    h.domain.mockResolvedValue({
      id: "host",
      domainId: "domain",
      connectionId: "igc_one",
      hostname: "app.example.test",
      accessPolicyId: null,
      status: "error",
      phase: "dns",
      error: "DNS already points elsewhere",
    });
    await render(
      <DomainIngressMenu
        domainId="domain"
        serverId="server"
        hostname="app.example.test"
        actions={[{ id: "edit", label: "Edit route", onClick: editRoute }]}
        triggerLabel="Manage app.example.test"
      />,
    );
    expect(host.textContent).not.toContain("Cloudflare Tunnel");
    expect(
      [...host.querySelectorAll("button")].some(
        (item) => item.textContent?.trim() === "Manage",
      ),
    ).toBe(false);
    const openMenu = async () => {
      await act(async () =>
        host
          .querySelector<HTMLButtonElement>(
            '[aria-label="Manage app.example.test"]',
          )!
          .click(),
      );
      await flush();
    };
    await openMenu();
    await click("Edit route");
    expect(editRoute).toHaveBeenCalledOnce();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await openMenu();
    await click("Cloudflare Tunnel");
    const modal = document.querySelector('[role="dialog"]')!;
    expect(modal.textContent).toContain("app.example.test");
    expect(modal.textContent).toContain("DNS already points elsewhere");
    expect(modal.querySelector('[role="switch"]')?.getAttribute("aria-checked")).toBe("false");
    await click("Retry setup", modal);
    expect(h.setDomain).toHaveBeenCalledWith({
      domainId: "domain",
      connectionId: "igc_one",
      accessPolicyId: null,
    });
  });
  it("discards pending private account details after an account switch", async () => {
    let resolve!: (value: unknown) => void;
    h.discover.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    await render(<ServerIngressCard serverId="server" />);
    await click("Connect tunnel");
    await select("Cloudflare credential", "Home");
    h.org = "other";
    h.credentials.mockResolvedValue({ data: [] });
    await render(<ServerIngressCard serverId="server" />);
    await act(async () =>
      resolve({
        accounts: [{ id: "old", name: "Private old account" }],
        tunnels: [],
        policies: [],
        policiesError: null,
      }),
    );
    await flush();
    expect(document.body.textContent).not.toContain("Private old account");
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(h.connect).not.toHaveBeenCalled();
  });
});
