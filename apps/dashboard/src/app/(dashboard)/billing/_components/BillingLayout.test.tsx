// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerDetail } from "@repo/contracts";
import { I18nProvider } from "@/components/i18n-provider";
import { PlatformProvider } from "@/context/PlatformContext";
import { baseDictionary } from "@/i18n";
import { BillingLayout } from "./BillingLayout";
import { BillingPageView, type BillingView } from "./BillingViewContext";
import { BillingContent } from "./BillingContent";

const h = vi.hoisted(() => ({
  userId: "user-a", organizationId: "org-a", path: "/billing/overview", query: "",
  list: vi.fn(), router: { push: vi.fn(), replace: vi.fn() },
}));
vi.mock("@/lib/auth-client", () => ({ useSession: () => ({
  data: { user: { id: h.userId }, session: { activeOrganizationId: h.organizationId } },
}) }));
vi.mock("next/navigation", () => ({
  usePathname: () => h.path, useSearchParams: () => new URLSearchParams(h.query), useRouter: () => h.router,
}));
vi.mock("@/lib/api/system", () => ({ systemApi: { listServerDestinations: h.list } }));
vi.mock("@/context/CloudContext", () => ({ useCloud: () => ({ startConnect: vi.fn(), refresh: vi.fn() }) }));

function server(id: string, name: string, tier = "starter"): ServerDetail {
  return {
    id, name, connection: "cloud", isLocal: false, sshHost: null, sshPort: null,
    sshUser: null, sshAuthMethod: null, sshKeyPath: null, hasStoredKeyMaterial: false,
    sshJumpHost: null, sshArgs: null, country: null, sshTransport: "direct", hostChannel: null,
    createdAt: "2026-10-01T00:00:00Z", projectCount: 0,
    capabilities: { monitor: true, terminal: true, exec: true, hostConfiguration: false, ssh: false },
    managed: { id: `cws-${id}`, serverId: id, name, planTierId: tier, subscriptionStatus: "active",
      projectCount: 0, state: tier === "free" ? "needs_plan" : "running", operation: null,
      resources: tier === "free" ? null : { cpuCores: 1, memoryMb: 4096, diskMb: 25600 },
      createdAt: "2026-10-01T00:00:00Z" },
  };
}
const production = server("production", "Production");
const staging = server("staging", "Staging");
let root: Root;
let host: HTMLDivElement;
const render = (children: ReactNode, selfHosted = false) => act(async () => root.render(
  <I18nProvider><PlatformProvider selfHosted={selfHosted}><BillingLayout>{children}</BillingLayout></PlatformProvider></I18nProvider>,
));
const page = (overrides: Partial<BillingView> = {}) => (
  <BillingPageView view={{ contextKey: "user-a:org-a", plansOnly: false, ...overrides }}><BillingContent sidebar={null}><p>Billing content</p></BillingContent></BillingPageView>
);
const tabs = () => [...host.querySelectorAll("nav a")];
const picker = () => host.querySelector<HTMLButtonElement>('button[aria-haspopup="listbox"]');
const serverButton = (name: string) => [...host.querySelectorAll<HTMLButtonElement>('aside button[aria-pressed]')].find(button => button.textContent?.includes(name))!;

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  h.userId = "user-a"; h.organizationId = "org-a"; h.path = "/billing/overview"; h.query = "";
  h.list.mockResolvedValue({ servers: [] });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals();
});

describe("billing navigation by server ownership", () => {
  it("shows only Plans for a new customer, without a server selector or add-server detour", async () => {
    h.path = "/billing/plans";
    await render(page({ plansOnly: true }));
    expect(tabs().map(tab => tab.textContent)).toEqual([baseDictionary.billing.tabs.plans]);
    expect(tabs()[0]?.getAttribute("aria-current")).toBe("page");
    expect(picker()).toBeNull();
    expect(host.querySelector('a[href="/servers/new"]')).toBeNull();
    expect(h.list).toHaveBeenCalledOnce();
    expect(h.router.replace).not.toHaveBeenCalled();
  });

  it("shows one server in the right card with the existing Add server flow", async () => {
    h.list.mockResolvedValue({ servers: [production] });
    await render(page({ workspaceId: "cws-production" }));
    expect(host.querySelector("header")?.textContent).not.toContain("Production");
    expect(host.querySelector("aside")?.textContent).toContain("Production");
    expect(serverButton("Production")).toBeUndefined();
    expect(picker()).toBeNull();
    expect(host.querySelector('a[href="/servers/new"]')?.textContent).toContain(baseDictionary.servers.setup.addServer);
    expect(tabs()).toHaveLength(6);
    expect(tabs().every(tab => tab.getAttribute("href")?.includes("workspaceId=cws-production"))).toBe(true);
    expect(h.router.replace).not.toHaveBeenCalled();
  });

  it("switches billing directly from visible server rows without another menu", async () => {
    h.query = "workspaceId=cws-production&organizationId=org-a";
    h.list.mockResolvedValue({ servers: [production, staging] });
    await render(page({ workspaceId: "cws-production", requestedWorkspaceId: "cws-production", organizationId: "org-a" }));
    expect(picker()).toBeNull();
    expect(serverButton("Production").getAttribute("aria-pressed")).toBe("true");
    expect(serverButton("Staging").getAttribute("aria-pressed")).toBe("false");
    await act(async () => serverButton("Staging").click());
    expect(h.router.push).toHaveBeenLastCalledWith("/billing/overview?workspaceId=cws-staging&organizationId=org-a", { scroll: false });
    expect(host.querySelector('aside a[href="/servers/new"]')?.textContent).toContain(baseDictionary.servers.setup.addServer);
    expect(h.list).toHaveBeenCalledOnce();
  });

  it("keeps the header and tabs mounted while another tab loads", async () => {
    h.list.mockResolvedValue({ servers: [production] });
    await render(page({ workspaceId: "cws-production" }));
    const header = host.querySelector("header");
    const nav = host.querySelector("nav");
    h.path = "/billing/usage";
    await render(<div role="status">Loading tab</div>);
    expect(host.querySelector("header")).toBe(header);
    expect(host.querySelector("nav")).toBe(nav);
    expect(tabs()).toHaveLength(6);
    expect(h.list).toHaveBeenCalledOnce();
  });

  it("reveals full billing navigation as soon as the subscription activates", async () => {
    h.path = "/billing/plans";
    await render(page({ plansOnly: true }));
    expect(tabs()).toHaveLength(1);
    await render(page({ plansOnly: false, workspaceId: "cws-production" }));
    expect(tabs()).toHaveLength(6);
  });

  it("does not expose the current organization's picker while opening a different organization", async () => {
    h.query = "organizationId=org-b";
    h.list.mockResolvedValue({ servers: [production, staging] });
    await render(page());
    expect(picker()).toBeNull();
    expect(host.querySelector("header")?.textContent).not.toContain("Production");
    expect(tabs()).toHaveLength(0);
    expect(h.router.replace).not.toHaveBeenCalled();
  });

  it("does not label an unavailable explicit scope as the sole available server", async () => {
    h.query = "workspaceId=cws-missing";
    h.list.mockResolvedValue({ servers: [production] });
    await render(page({ requestedWorkspaceId: "cws-missing" }));
    expect(picker()).toBeNull();
    expect(serverButton("Production").getAttribute("aria-pressed")).toBe("false");
    await act(async () => serverButton("Production").click());
    expect(h.router.push).toHaveBeenLastCalledWith("/billing/overview?workspaceId=cws-production", { scroll: false });
    expect(tabs().every(tab => tab.getAttribute("href")?.includes("workspaceId=cws-missing"))).toBe(true);
    expect(h.router.replace).not.toHaveBeenCalled();
  });

  it("ignores a late page from the previous server while keeping the requested scope", async () => {
    h.query = "workspaceId=cws-production";
    const productionPage = page({ requestedWorkspaceId: "cws-production", workspaceId: "cws-production" });
    await render(productionPage);
    h.query = "workspaceId=cws-staging";
    await render(productionPage);
    expect(tabs().every(tab => tab.getAttribute("href")?.includes("workspaceId=cws-staging"))).toBe(true);
  });

  it("clears navigation and inventory when the account changes", async () => {
    h.list.mockResolvedValueOnce({ servers: [production] });
    const oldPage = page({ workspaceId: "cws-production" });
    await render(oldPage);
    h.userId = "user-b";
    await render(oldPage);
    expect(host.textContent).not.toContain("Production");
    expect(tabs()).toHaveLength(0);
    await render(page({ contextKey: "user-b:org-a", plansOnly: true }));
    expect(tabs()).toHaveLength(1);
    expect(tabs()[0]?.getAttribute("href")).toBe("/billing/plans");
  });

  it("keeps the billing view visible and offers a retry when inventory cannot load", async () => {
    let reject!: (error: Error) => void;
    h.list.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
    await render(page());
    expect(host.textContent).toContain("Billing content");
    await act(async () => reject(new Error("Temporarily unavailable")));
    const retry = host.querySelector<HTMLButtonElement>("aside button")!;
    expect(retry.textContent).toContain("Try again");
    h.list.mockResolvedValueOnce({ servers: [production, staging] });
    await act(async () => retry.click());
    expect(serverButton("Staging")).toBeDefined();
    expect(host.textContent).toContain("Billing content");
    expect(tabs()).toHaveLength(6);
  });

  it("does not fetch managed destinations or change self-hosted server navigation", async () => {
    await render(page(), true);
    expect(tabs()).toHaveLength(6);
    expect(picker()).toBeNull();
    expect(h.list).not.toHaveBeenCalled();
    expect(h.router.replace).not.toHaveBeenCalled();
  });
});
