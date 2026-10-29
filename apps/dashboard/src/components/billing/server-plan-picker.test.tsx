// @vitest-environment happy-dom
import { act, StrictMode, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PRICING, pricingUi, resolvePlan, type CustomServerResources, type PlanTierId } from "@repo/core";
import type { ManagementState, BillingCustomQuote, BillingPlans, BillingSubscription, CloudWorkspaceSummary } from "@repo/contracts";
import { I18nProvider } from "@/components/i18n-provider";
import { PlatformProvider } from "@/context/PlatformContext";
import { ModalProvider } from "@/context/ModalContext";
import { SidebarLayoutProvider, useSidebarLayout } from "@/context/SidebarLayoutContext";
import { useSidebarCollapse } from "@/hooks/useSidebarCollapse";
import { baseDictionary } from "@/i18n";
import { BillingPlanSummary } from "@/app/(dashboard)/billing/_components/billing-shared";
import { BillingPlansRoute } from "@/app/(dashboard)/billing/_components/BillingPlansRoute";
import { BillingPurchaseContent } from "@/app/(dashboard)/billing/_components/BillingPurchaseContent";
import { BillingHeader } from "@/app/(dashboard)/billing/_components/BillingHeader";
import { ManagedServerPurchase } from "@/components/servers/managed/ManagedServerPurchase";
import { ManagedServerSetup } from "@/components/servers/ServerAcquisition";
import { useAddServerModal } from "@/components/servers/add-server-modal";
import { BillingWorkspaceProvider } from "./BillingWorkspaceContext";
import { CloudPlanPicker } from "./CloudPlanPicker";
import { CloudPurchaseProvider, CloudPurchaseTabs } from "./CloudPurchaseContext";
import type { ApiPlan } from "./PricingCards";
import type { BillingState } from "@/lib/api/billing";
import { ApiError } from "@/lib/api/client";

const h = vi.hoisted(() => ({
  get: vi.fn(), post: vi.fn(), create: vi.fn(), available: vi.fn(), connect: vi.fn(), readServer: vi.fn(), selected: vi.fn(), remove: vi.fn(),
  user: "user-a", org: "org-a", connected: true, sessionPending: false,
}));
vi.mock("@/lib/api/client", async original => ({ ...await original<typeof import("@/lib/api/client")>(), api: { get: h.get, post: h.post } }));
vi.mock("@/lib/api/system", () => ({ systemApi: { createManagedServer: h.create, availableManagedServers: h.available, connectManagedServer: h.connect, getServerById: h.readServer, removeManagedServer: h.remove } }));
vi.mock("@/lib/auth-client", () => ({ useSession: () => ({ isPending: h.sessionPending, data: { user: { id: h.user }, session: { activeOrganizationId: h.org } } }) }));
vi.mock("@/context/CloudContext", () => ({ useCloud: () => ({ connected: h.connected, startConnect: vi.fn() }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));

const copy = baseDictionary.billing;
const plans: ApiPlan[] = (["hobby", "starter", "pro", "team", "enterprise"] as const).map(id => {
  const source = resolvePlan(id);
  return { ...source, features: [...source.features], resourceLimits: source.oblienLimits,
    listPrice: { monthly: source.price.monthly }, effectivePrice: { monthly: source.price.monthly }, campaign: null };
});
const offer = (id: PlanTierId) => plans.find(plan => plan.id === id)!;
const catalog = { data: { plans, custom: PRICING.custom, payg: PRICING.payg, ui: pricingUi("en"), annual: { enabled: false, monthsFree: 0 } } };
const computePricing: NonNullable<BillingPlans["computePricing"]> = {
  tariffId: "test-tariff", currency: "usd", creditsPerDollar: 100, paygCapPercent: 125,
  usage: { activeVcpuHourCents: 3, reservedGiBHourCents: 0.8, retainedGiBMonthCents: 5, monthHours: 720 },
  network: { managedProxyGiBCents: 10, minimumTopupCents: 500 }, retentionDays: 30,
  paygCheckoutAvailable: false,
};
const subscription = (tier: PlanTierId): BillingSubscription => ({
  tier, configuration: "preset", status: "active", interval: "monthly", offerReference: `saved-${tier}`,
  currentPeriod: { start: "2026-10-01T00:00:00Z", end: "2026-11-01T00:00:00Z" },
  cancelAtPeriodEnd: false, canceledAt: null,
});
const server: CloudWorkspaceSummary = {
  id: "cws-new", serverId: "server-new", name: "Production", planTierId: "free", subscriptionStatus: "active",
  state: "needs_plan", projectCount: 0, operation: null, resources: null, createdAt: "2026-10-01T00:00:00Z",
};
function customQuote(resources: CustomServerResources): BillingCustomQuote {
  return { basePlanTierId: "team", reference: `quoted-${resources.cpuCores}-${resources.memoryMb}-${resources.diskGb}`,
    resources: { cpuCores: resources.cpuCores, memoryMb: resources.memoryMb, diskGb: resources.diskGb }, priceCents: 11900 + (resources.cpuCores - 8) * 600, currency: "usd", billingMode: "monthly", monthlyCredits: null,
    breakdown: { basePriceCents: 11900, cpuCents: (resources.cpuCores - 8) * 600, memoryCents: 0, diskCents: 0 } };
}
let management: ManagementState;
let root: Root;
let host: HTMLDivElement;
let popup: { opener: object | null; closed: boolean; location: { href: string }; close: ReturnType<typeof vi.fn> };
function SidebarState() {
  const { autoCollapse } = useSidebarLayout();
  const { collapsed } = useSidebarCollapse("plans", autoCollapse);
  return <output aria-label="Desktop sidebar">{collapsed ? "collapsed" : "expanded"}</output>;
}
const sidebarState = () => host.querySelector('output[aria-label="Desktop sidebar"]')?.textContent;
const render = (node: ReactNode, selfHosted = false) => act(async () => root.render(
  <I18nProvider><PlatformProvider selfHosted={selfHosted}>
    <SidebarLayoutProvider><SidebarState />{node}</SidebarLayoutProvider>
  </PlatformProvider></I18nProvider>,
));
const buttons = (label: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].filter(button => button.textContent?.trim() === label);
const click = (label: string) => act(async () => {
  const button = buttons(label)[0]; expect(button, label).toBeDefined(); button!.click();
});
const planNames = () => [...host.querySelectorAll("article h3")].map(heading => heading.textContent);
function input(label: string) {
  const field = [...host.querySelectorAll("label")].find(node => node.textContent?.includes(label));
  return field?.querySelector("input") ?? document.getElementById(field?.htmlFor ?? "") as HTMLInputElement | null;
}
async function edit(field: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const flushQuote = () => act(async () => { await vi.advanceTimersByTimeAsync(250); });
function picker(tier: PlanTierId, extra: Partial<React.ComponentProps<typeof CloudPlanPicker>> = {}) {
  return <CloudPlanPicker workspaceId="cws-production" currentPlan={tier} currentOffer={offer(tier)}
    subscription={subscription(tier)} billingEnabled canChangeSubscription {...extra} />;
}

function AddServerFromProject() {
  const addServer = useAddServerModal();
  return <><input aria-label="Project name" defaultValue="Keep this project" /><button onClick={() => addServer(h.selected)}>Add a destination</button></>;
}

beforeEach(() => {
  vi.resetAllMocks(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  h.user = "user-a"; h.org = "org-a"; h.connected = true; h.sessionPending = false;
  window.location.href = "http://localhost:3000/";
  management = { pricing: PRICING.management, purchasesAvailable: true, cloudIncluded: false,
    active: false, serverLimit: 0, connectedServers: 0, pendingCheckout: false, subscription: null, change: null };
  h.get.mockImplementation(async (path, options) => path === "/billing/manage" ? { data: management } : path.endsWith("/quote")
    ? { data: customQuote(options.params) } : catalog);
  h.create.mockResolvedValue(server);
  h.readServer.mockResolvedValue({ id: server.serverId, name: server.name, managed: server });
  h.available.mockResolvedValue({ servers: [] });
  h.post.mockResolvedValue({ data: { checkoutUrl: "https://checkout.example.test/new-server" } });
  popup = { opener: {}, closed: false, location: { href: "about:blank" }, close: vi.fn() };
  vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

describe("Manage purchase tab", () => {
  const billing = () => <CloudPurchaseProvider management tabs="header" scopeKey={`${h.user}:${h.org}`}>
    <BillingHeader /><CloudPurchaseTabs />
    <BillingPurchaseContent><BillingPlansRoute currentPlan="free" subscription={null} workspaceId="cws-production" billingEnabled /></BillingPurchaseContent>
  </CloudPurchaseProvider>;
  const panel = () => {
    const tab = buttons(copy.purchase.manage)[0]!;
    return document.getElementById(tab.getAttribute("aria-controls")!)!;
  };

  it("offers Manage third and loads its shared subscription view only when selected", async () => {
    await render(billing());
    expect([...host.querySelectorAll('[role="tab"]')].map(tab => tab.textContent)).toEqual([
      copy.purchase.monthly, copy.purchase.payg, copy.purchase.manage,
    ]);
    expect(planNames()).toEqual(["Hobby", "Starter", "Pro", "Scale"]);
    expect(h.get.mock.calls.some(([path]) => path === "/billing/manage")).toBe(false);
    expect(host.querySelector('a[href="/billing/manage"]')).toBeNull();
    await click(copy.purchase.manage);
    expect(panel().hidden).toBe(false);
    expect(panel().textContent).toContain("$5/mo");
    expect(panel().textContent).toContain("2 connected servers");
    expect(host.querySelector("h1")?.textContent).toBe(copy.purchase.manage);
    expect(h.get.mock.calls.filter(([path]) => path === "/billing/manage")).toHaveLength(1);
    expect(h.create).not.toHaveBeenCalled();
    expect(h.post).not.toHaveBeenCalled();
    expect(sidebarState()).toBe("expanded");
  });

  it("preserves Custom input and hides Cloud controls while Manage is open", async () => {
    vi.useFakeTimers();
    await render(billing());
    await click(copy.custom.name); await flushQuote();
    await edit(input(copy.custom.cpu)!, "3"); await flushQuote();
    await click(copy.purchase.manage);
    expect(buttons(copy.custom.name)[0]?.closest("[hidden]")).not.toBeNull();
    expect(input(copy.custom.cpu)?.closest("[hidden]")).not.toBeNull();
    await click(copy.purchase.monthly);
    expect(panel().hidden).toBe(true);
    expect(input(copy.custom.cpu)?.value).toBe("3");
    expect(buttons(copy.custom.name)[0]?.closest("[hidden]")).toBeNull();
  });

  it("uses the existing management checkout and blocks switching until it settles", async () => {
    await render(billing()); await click(copy.purchase.manage);
    let finish!: (value: unknown) => void;
    h.post.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    await click("Continue to checkout");
    expect(h.post).toHaveBeenCalledExactlyOnceWith("/billing/manage/checkout", {
      servers: 2, plan: "basic", idempotencyKey: expect.any(String),
    });
    expect(buttons(copy.purchase.monthly)[0]?.closest("fieldset")?.disabled).toBe(true);
    expect(h.create).not.toHaveBeenCalled();
    await act(async () => finish({ data: { quoteId: "manage-quote", monthlyCents: 500, amountDueNow: 500 } }));
    expect(panel().textContent).toContain("Review your change");
    expect(buttons(copy.purchase.monthly)[0]?.closest("fieldset")?.disabled).toBe(false);
  });

  it("resets the view on an organization change and ignores the previous account's late response", async () => {
    let finish!: (value: unknown) => void;
    h.get.mockImplementation(path => path === "/billing/manage" ? new Promise(resolve => { finish = resolve; }) : Promise.resolve(catalog));
    await render(billing()); await click(copy.purchase.manage);
    h.org = "org-b";
    await render(billing());
    expect(buttons(copy.purchase.monthly)[0]?.getAttribute("aria-selected")).toBe("true");
    await act(async () => finish({ data: { ...management, connectedServers: 77 } }));
    expect(panel().textContent).not.toContain("77");
    expect(panel().hidden).toBe(true);
  });

  it("keeps Manage usable when the compute catalog is unavailable", async () => {
    h.get.mockImplementation(path => path === "/billing/manage" ? Promise.resolve({ data: management }) : Promise.reject(new Error("Cloud unavailable")));
    await render(billing()); await click(copy.purchase.manage);
    expect(panel().textContent).toContain("Continue to checkout");
    expect(panel().hidden).toBe(false);
  });

  it("does not add a management choice to the deployment or server-acquisition picker", async () => {
    await render(<ManagedServerPurchase preserveProject />);
    expect(buttons(copy.purchase.manage)).toHaveLength(0);
    expect(h.get.mock.calls.some(([path]) => path === "/billing/manage")).toBe(false);
  });
});

describe("referral checkout handoff", () => {
  const code = "AF-0123456789";
  const referral = { code, name: "Community", productId: "workspace_vm", planId: null,
    discountBps: 500, durationMonths: 12, expiresAt: null, minimumMonthlyCents: 1000 };
  const purchase = () => <ManagedServerPurchase requestedPlanId="starter" initialReferralCode={code} autoCheckout />;

  it("waits for verified terms then uses the ordinary checkout with the referral", async () => {
    let resolve!: (value: unknown) => void;
    const ordinary = h.get.getMockImplementation()!;
    h.get.mockImplementation((path, options) => path === `referrals/${code}` ? new Promise(r => { resolve = r; }) : ordinary(path, options));
    await render(purchase());
    expect(h.create).not.toHaveBeenCalled();
    expect(h.post).not.toHaveBeenCalled();
    await act(async () => resolve({ data: referral }));
    expect(h.create).toHaveBeenCalledOnce();
    expect(h.post).toHaveBeenCalledExactlyOnceWith("billing/subscription", expect.objectContaining({
      workspaceId: server.id, planTierId: "starter", affiliateCode: code,
    }));
  });

  it("does not silently charge full price when the referral is unavailable", async () => {
    const ordinary = h.get.getMockImplementation()!;
    h.get.mockImplementation((path, options) => path === `referrals/${code}` ? Promise.reject(new Error("Referral expired")) : ordinary(path, options));
    await render(purchase());
    expect(host.textContent).toContain("Referral expired");
    expect(h.create).not.toHaveBeenCalled(); expect(h.post).not.toHaveBeenCalled();
    await click(baseDictionary.affiliates.remove);
    expect(h.post).toHaveBeenCalledExactlyOnceWith("billing/subscription", expect.not.objectContaining({ affiliateCode: expect.anything() }));
  });
});

describe("annual Cloud purchases", () => {
  beforeEach(() => {
    h.get.mockImplementation(async (path, options) => {
      if (path.endsWith("/quote")) {
        const annual = options.params.interval === "annual";
        return { data: { ...customQuote(options.params), reference: annual ? "quote-annual" : "quote-monthly",
          interval: options.params.interval, priceCents: annual ? 118800 : 11900 } };
      }
      return { data: { ...catalog.data, annual: { enabled: true, monthsFree: 2 } } };
    });
  });
  const purchase = () => <CloudPlanPicker currentPlan="free" subscription={null} workspaceId="cws-production" billingEnabled />;

  it.each(["annual", "monthly"] as const)("preserves a website %s selection through server creation and checkout", async requestedInterval => {
    await render(<ManagedServerPurchase requestedPlanId="starter" requestedInterval={requestedInterval} autoCheckout />);
    expect(h.create).toHaveBeenCalledOnce();
    expect(h.post).toHaveBeenCalledExactlyOnceWith("billing/subscription", expect.objectContaining({
      planTierId: "starter", interval: requestedInterval, workspaceId: server.id,
    }));
  });

  it("does not silently purchase monthly when the requested annual offer is disabled", async () => {
    h.get.mockResolvedValue(catalog);
    await render(<ManagedServerPurchase requestedPlanId="starter" requestedInterval="annual" autoCheckout />);
    expect(host.textContent).toContain(copy.plansRoute.requestedPlanUnavailable);
    expect(h.create).not.toHaveBeenCalled();
    expect(h.post).not.toHaveBeenCalled();
  });

  it("shows monthly equivalents with the upfront annual charge and submits yearly checkout", async () => {
    await render(purchase());
    expect(buttons(copy.pricing.annual)[0]?.getAttribute("aria-pressed")).toBe("true");
    expect(host.querySelector("article .text-2xl")?.textContent).toBe("$10");
    await click(copy.pricing.monthly);
    expect(host.querySelector("article .text-2xl")?.textContent).toBe("$12");
    await click(copy.pricing.annual);
    expect(host.querySelector("article")?.textContent).toContain("$10");
    expect(host.querySelector("article")?.textContent).toContain("$120 billed yearly");
    await click("Choose Hobby");
    expect(h.post).toHaveBeenCalledExactlyOnceWith("billing/subscription", expect.objectContaining({
      planTierId: "hobby", interval: "annual", workspaceId: "cws-production",
    }));
  });
  it("invalidates Custom quotes when switching intervals and submits the selected annual quote", async () => {
    vi.useFakeTimers();
    await render(purchase()); await click(copy.pricing.monthly); await click(copy.custom.name); await flushQuote();
    await click(copy.pricing.annual);
    expect(host.querySelector('form button[type="submit"]')?.hasAttribute("disabled")).toBe(true);
    expect(h.post).not.toHaveBeenCalled();
    await flushQuote();
    expect(host.querySelector("aside")?.textContent).toContain("$1188 billed yearly");
    await act(async () => host.querySelector<HTMLFormElement>("form")!.requestSubmit());
    expect(h.post).toHaveBeenCalledExactlyOnceWith("billing/subscription", expect.objectContaining({
      interval: "annual", custom: expect.objectContaining({ quoteReference: "quote-annual" }),
    }));
    const query = h.get.mock.calls.filter(([path]) => path.endsWith("/quote")).at(-1)![1];
    expect(query.params.interval).toBe("annual");
  });
});

describe("plans for an existing server", () => {
  it("shows the saved paid plan once and offers only larger presets by default", async () => {
    await render(picker("starter", { billingState: { tier: "starter", status: "active", plan: offer("starter"), subscription: subscription("starter") } as BillingState }));
    expect(host.querySelectorAll('section[aria-label="Current plan"]')).toHaveLength(1);
    expect(host.querySelector('section[aria-label="Current plan"]')?.textContent).toContain("Starter");
    expect(host.querySelector('section[aria-label="Current plan"]')?.textContent).toContain("$24");
    expect(planNames()).toEqual(["Pro", "Scale"]);
    expect(sidebarState()).toBe("expanded");
    expect(host.textContent).toContain(copy.plansRoute.upgradeServer);
    expect(h.post).not.toHaveBeenCalled();
  });

  it("keeps lower-cost choices behind Other plans and excludes retired offers", async () => {
    h.get.mockResolvedValueOnce({ data: { ...catalog.data, plans: plans.map(plan => ({ ...plan, availableForPurchase: plan.id !== "hobby" })) } });
    await render(picker("pro"));
    await click(copy.plansRoute.otherPlans);
    expect(planNames()).toContain("Starter");
    expect(planNames()).not.toContain("Hobby");
    expect(host.textContent).toContain(copy.plansRoute.otherPlansHint);
    h.post.mockRejectedValueOnce(new Error("Preview offline"));
    await click(copy.planChange.review);
    expect(h.post).toHaveBeenCalledWith("billing/subscription/change/preview", expect.objectContaining({ workspaceId: "cws-production", planTierId: "starter" }));
    await click(copy.plansRoute.backToUpgrades);
    expect(planNames()).toEqual(["Scale"]);
    expect(sidebarState()).toBe("expanded");
  });

  it("opens Custom from Scale with the saved resources and disables an unchanged purchase", async () => {
    vi.useFakeTimers();
    await render(picker("team", { allocatedDiskGb: 600 }));
    expect(host.querySelector(`form[aria-label="${copy.custom.title}"]`)).not.toBeNull();
    expect(sidebarState()).toBe("expanded");
    expect(input(copy.custom.cpu)?.value).toBe("8");
    expect(input(copy.custom.memory)?.value).toBe("32");
    expect(input(copy.custom.disk)?.value).toBe("600");
    await flushQuote();
    expect(buttons(copy.pricing.currentPlan)[0]?.disabled).toBe(true);
    await edit(input(copy.custom.cpu)!, "9");
    expect(buttons(copy.planChange.review)[0]?.disabled).toBe(true);
    await flushQuote();
    h.post.mockRejectedValueOnce(new Error("Preview offline"));
    await click(copy.planChange.review);
    expect(h.post).toHaveBeenCalledExactlyOnceWith("billing/subscription/change/preview", expect.objectContaining({
      workspaceId: "cws-production", custom: { resources: { cpuCores: 9, memoryMb: 32768, diskGb: 600 }, quoteReference: "quoted-9-32768-600" },
    }));
    expect(h.post.mock.calls.some(([path]) => path === "billing/subscription")).toBe(false);
  });

  it("resets custom inputs and pending quotes when switching to another server", async () => {
    vi.useFakeTimers();
    await render(picker("team")); await flushQuote();
    await edit(input(copy.custom.cpu)!, "12");
    await render(picker("pro", { workspaceId: "cws-staging" }));
    expect(planNames()).toEqual(["Scale"]);
    await click(copy.custom.name); await flushQuote();
    expect(input(copy.custom.cpu)?.value).toBe("4");
    expect(input(copy.custom.memory)?.value).toBe("16");
    expect(h.post).not.toHaveBeenCalled();
  });

  it("restores an inactive server through its own checkout without offering smaller disks", async () => {
    await render(picker("free", { currentOffer: null, subscription: null, preserveProject: true, allocatedDiskGb: 128 }));
    expect(planNames()).toEqual(["Starter", "Pro", "Scale"]);
    await click("Choose Starter");
    expect(h.post).toHaveBeenCalledWith("billing/subscription", expect.objectContaining({ workspaceId: "cws-production", planTierId: "starter" }));
    expect(h.create).not.toHaveBeenCalled();
  });

  it("keeps pending payment visible and blocks a second plan change", async () => {
    const pendingChange = {
      id: "change-a", direction: "upgrade" as const, status: "payment_pending" as const, currency: "usd" as const,
      current: { name: "Starter", priceCents: 2000 }, next: { name: "Pro", priceCents: 3900 },
      effectiveAt: "2026-10-03T00:00:00Z", amountDueNow: 1250, paymentUrl: "https://checkout.example.test/upgrade",
      paymentExpiresAt: null, errorCode: null, cancelable: true, appliedAt: null,
    };
    await render(picker("starter", { subscription: { ...subscription("starter"), pendingChange } }));
    expect(host.textContent).toContain(copy.planChange.paymentPending);
    expect(host.querySelector('a[href="https://checkout.example.test/upgrade"]')).not.toBeNull();
    expect(buttons("Choose Pro")[0]?.disabled).toBe(true);
    expect(h.post).not.toHaveBeenCalled();
  });

  it("keeps navigation expanded while loading and uses the remaining plans when the server changes", async () => {
    let ready!: (value: typeof catalog) => void;
    h.get.mockReturnValueOnce(new Promise(resolve => { ready = resolve; }));
    await render(picker("hobby"));
    expect(sidebarState()).toBe("expanded");
    await act(async () => ready(catalog));
    expect(planNames()).toEqual(["Starter", "Pro", "Scale"]);
    expect(sidebarState()).toBe("collapsed");
    await render(picker("pro", { workspaceId: "cws-staging" }));
    expect(planNames()).toEqual(["Scale"]);
    expect(sidebarState()).toBe("expanded");
    expect(h.get).toHaveBeenCalledTimes(1);
  });
});

describe("buying another managed server", () => {
  it("uses normal width for Custom and extra width for the full comparison and PAYG", async () => {
    h.get.mockResolvedValue({ data: { ...catalog.data, computePricing } });
    await render(<ManagedServerPurchase />);
    expect(sidebarState()).toBe("collapsed");
    await click(copy.custom.name);
    expect(sidebarState()).toBe("expanded");
    await click(copy.custom.presets);
    expect(sidebarState()).toBe("collapsed");
    await click(copy.purchase.payg);
    expect(sidebarState()).toBe("collapsed");
    expect(h.post).not.toHaveBeenCalled();
  });

  it("keeps typed resources when switching PAYG tiers and offers a pool that fits the server", async () => {
    h.get.mockResolvedValue({ data: { ...catalog.data, computePricing } });
    await render(<ManagedServerPurchase />);
    await click(copy.purchase.payg);
    await click("Tier 1");
    await edit(input(copy.custom.cpu)!, "3");
    const panel = document.getElementById(buttons(copy.purchase.payg)[0]!.getAttribute("aria-controls")!)!;
    expect(panel.querySelector('[role="alert"]')?.textContent).toContain("exceeds Tier 1");
    expect(panel.querySelector("aside")?.textContent).not.toContain("$0.1077");
    await click("View Tier 2");
    expect(input(copy.custom.cpu)?.value).toBe("3");
    expect(panel.querySelector('[role="alert"]')).toBeNull();
    expect(panel.querySelector("aside")?.textContent).toContain("$0.1077");
    await click(copy.purchase.monthly);
    await click(copy.purchase.payg);
    expect(buttons("Tier 2")[0]?.getAttribute("aria-selected")).toBe("true");
    expect(input(copy.custom.cpu)?.value).toBe("3");
    expect(h.create).not.toHaveBeenCalled(); expect(h.post).not.toHaveBeenCalled();
  });

  it("keeps resource limits separate from credit packages and never treats a selection as paid access", async () => {
    h.get.mockResolvedValue({ data: { ...catalog.data, computePricing } });
    await render(<ManagedServerPurchase />);
    await click(copy.purchase.payg);
    await click("Tier 1");
    await edit(input(copy.custom.cpu)!, "3");
    const panel = document.getElementById(buttons(copy.purchase.payg)[0]!.getAttribute("aria-controls")!)!;
    await act(async () => panel.querySelector<HTMLButtonElement>('button[value="10000"]')!.click());
    expect(buttons("Tier 1")[0]?.getAttribute("aria-selected")).toBe("true");
    expect(panel.querySelector('[role="alert"]')?.textContent).toContain("exceeds Tier 1");
    expect(panel.textContent).toContain("This package unlocks Tier 3");
    expect(buttons("Add 10,000 credits")[0]?.disabled).toBe(true);
    await click("Tier 3");
    await act(async () => panel.querySelector<HTMLButtonElement>('button[value="500"]')!.click());
    expect(buttons("Tier 3")[0]?.getAttribute("aria-selected")).toBe("true");
    expect(panel.textContent).toContain("Tier 3 needs $50.00 in total credit purchases");
    expect(h.post).not.toHaveBeenCalled(); expect(h.create).not.toHaveBeenCalled();
  });

  it("previews one server at full CPU without checkout, and preserves resources across billing modes", async () => {
    h.get.mockResolvedValue({ data: { ...catalog.data, computePricing } });
    await render(<ManagedServerPurchase />);
    await click(copy.purchase.payg);
    const panel = document.getElementById(buttons(copy.purchase.payg)[0]!.getAttribute("aria-controls")!)!;
    const estimate = panel.querySelector("aside")!;
    expect(estimate.textContent).toContain("$0.0477");
    expect(estimate.textContent).toContain("4.77 credits/hour");
    expect(estimate.textContent).toContain(copy.purchase.hourlyHint);
    expect(panel.querySelectorAll('input[type="number"]')).toHaveLength(3);
    expect(estimate.querySelector("details")?.open).toBe(false);
    expect(estimate.textContent).not.toMatch(/30-day|Assumes|Compare monthly hosts/);
    expect(estimate.textContent).toContain("17.5 days");
    expect(estimate.textContent).toContain("47 days");
    await act(async () => panel.querySelector<HTMLButtonElement>('button[value="500"]')!.click());
    expect(estimate.textContent).toContain("4.4 days");
    expect(estimate.textContent).toContain("11.7 days");
    await edit(input(copy.custom.cpu)!, "2");
    expect(estimate.textContent).toContain("2.7 days");
    expect(estimate.textContent).toContain("$0.0777");
    expect(estimate.textContent).toContain("2 vCPU-h");
    expect(estimate.textContent).toContain("6 credits");
    expect(panel.textContent).toContain("2 vCPU × 100% = 2 vCPU-h");
    expect(buttons("Add 500 credits")[0]?.disabled).toBe(true);
    await click(copy.purchase.monthly);
    expect(buttons(copy.purchase.monthly)[0]?.getAttribute("aria-selected")).toBe("true");
    await click(copy.purchase.payg);
    expect(input(copy.custom.cpu)?.value).toBe("2");
    expect(panel.querySelector('button[value="500"]')?.getAttribute("aria-pressed")).toBe("true");
    expect(h.create).not.toHaveBeenCalled();
    expect(h.post).not.toHaveBeenCalled();
    expect(window.open).not.toHaveBeenCalled();
  });

  it("estimates custom PAYG resources immediately without requesting a monthly quote", async () => {
    vi.useFakeTimers();
    h.get.mockResolvedValue({ data: { ...catalog.data, computePricing } });
    await render(<ManagedServerPurchase />);
    await click(copy.purchase.payg);
    h.get.mockClear();
    await edit(input(copy.custom.cpu)!, "4");
    await act(async () => { await vi.advanceTimersByTimeAsync(600); });
    const panel = document.getElementById(buttons(copy.purchase.payg)[0]!.getAttribute("aria-controls")!)!;
    expect(panel.querySelector("aside")?.textContent).toContain("$0.1377");
    expect(h.get).not.toHaveBeenCalled();
    expect(h.post).not.toHaveBeenCalled();
  });

  it("clears an invalid estimate and cannot open PAYG checkout even if the catalog advertises availability", async () => {
    h.get.mockResolvedValue({ data: { ...catalog.data, computePricing: { ...computePricing, paygCheckoutAvailable: true } } });
    await render(<ManagedServerPurchase />);
    await click(copy.purchase.payg);
    await edit(input(copy.custom.cpu)!, "0");
    const panel = document.getElementById(buttons(copy.purchase.payg)[0]!.getAttribute("aria-controls")!)!;
    expect(panel.querySelector('[role="alert"]')?.textContent).toBe(copy.purchase.invalid);
    expect(panel.querySelector("aside")?.textContent).not.toContain("17.5 days");
    const buy = buttons("Add 2,000 credits")[0]!;
    expect(buy.disabled).toBe(true);
    await act(async () => buy.click());
    expect(h.create).not.toHaveBeenCalled(); expect(h.post).not.toHaveBeenCalled();
  });

  it("keeps configuration in the page header and retains custom resources across purchase modes", async () => {
    vi.useFakeTimers();
    await render(<CloudPurchaseProvider tabs="header">
      <BillingHeader /><CloudPurchaseTabs /><ManagedServerPurchase />
    </CloudPurchaseProvider>);
    expect(host.querySelector("h1")?.textContent).toBe(copy.onboarding.compareTitle);
    expect([...host.querySelectorAll("h1, h2")].filter(node => node.textContent === copy.onboarding.compareTitle)).toHaveLength(1);
    expect(host.querySelectorAll('[role="tablist"]')).toHaveLength(1);
    expect(buttons(copy.custom.presets)).toHaveLength(1);
    expect(buttons(copy.custom.name)).toHaveLength(1);
    expect(buttons(copy.custom.presets)[0]?.getAttribute("aria-pressed")).toBe("true");
    expect(host.querySelector("header")?.contains(buttons(copy.custom.name)[0]!)).toBe(true);
    await click(copy.custom.name); await flushQuote();
    expect(buttons(copy.custom.name)[0]?.getAttribute("aria-pressed")).toBe("true");
    expect(buttons(copy.custom.presets)[0]?.getAttribute("aria-pressed")).toBe("false");
    await edit(input(copy.custom.cpu)!, "3"); await flushQuote();
    const monthly = buttons(copy.purchase.monthly)[0]!;
    const panel = document.getElementById(monthly.getAttribute("aria-controls")!)!;
    expect(panel.hidden).toBe(false);

    await click(copy.purchase.payg);
    expect(host.querySelector("h1")?.textContent).toBe(copy.purchase.title);
    expect(panel.hidden).toBe(true);
    expect(buttons(copy.purchase.payg)[0]?.getAttribute("aria-selected")).toBe("true");
    const payg = document.getElementById(buttons(copy.purchase.payg)[0]!.getAttribute("aria-controls")!)!;
    expect(payg.hidden).toBe(false);
    expect(payg.textContent).toContain(copy.purchase.ratesUnavailable);
    expect(h.create).not.toHaveBeenCalled();
    expect(h.post).not.toHaveBeenCalled();

    await click(copy.purchase.compareMonthly);
    expect(host.querySelector("h1")?.textContent).toBe(copy.onboarding.compareTitle);
    expect(panel.hidden).toBe(false);
    expect(input(copy.custom.cpu)?.value).toBe("3");
    expect(buttons(copy.custom.name)[0]?.getAttribute("aria-pressed")).toBe("true");
    await click(copy.custom.presets);
    expect(planNames()).toEqual(["Hobby", "Starter", "Pro", "Scale"]);
    expect(buttons(copy.custom.presets)[0]?.getAttribute("aria-pressed")).toBe("true");
  });

  it("supports keyboard switching and resets the purchase choice when the account changes", async () => {
    const page = (scopeKey: string) => <CloudPurchaseProvider scopeKey={scopeKey} tabs="header">
      <BillingHeader /><CloudPurchaseTabs /><ManagedServerPurchase preserveProject />
    </CloudPurchaseProvider>;
    await render(page("user-a:org-a"));
    const monthly = buttons(copy.purchase.monthly)[0]!;
    monthly.focus();
    await act(async () => monthly.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true })));
    const payg = buttons(copy.purchase.payg)[0]!;
    expect(document.activeElement).toBe(payg);
    expect(payg.getAttribute("aria-selected")).toBe("true");
    h.user = "user-b";
    await render(page("user-b:org-a"));
    expect(buttons(copy.purchase.monthly)[0]?.getAttribute("aria-selected")).toBe("true");
    expect(h.post).not.toHaveBeenCalled();
    expect(h.create).not.toHaveBeenCalled();
  });

  it("keeps mode navigation in the page header when billing state resolves", async () => {
    vi.useFakeTimers();
    const page = (ready: boolean) => <CloudPurchaseProvider tabs={ready ? "header" : "none"}>
      <BillingHeader />{ready && <CloudPurchaseTabs />}<ManagedServerPurchase preserveProject />
    </CloudPurchaseProvider>;
    await render(page(false));
    expect(host.querySelector('[role="tablist"]')).toBeNull();
    expect(host.querySelector('[role="tabpanel"]')).toBeNull();
    await click(copy.custom.name); await flushQuote();
    await edit(input(copy.custom.cpu)!, "3"); await flushQuote();
    await render(page(true));
    expect(host.querySelectorAll('[role="tablist"]')).toHaveLength(1);
    expect(input(copy.custom.cpu)?.value).toBe("3");
    expect(host.querySelector("header")?.contains(buttons(copy.custom.name)[0]!)).toBe(true);
  });

  it("locks the billing model while a checkout is being prepared", async () => {
    let finish!: (server: CloudWorkspaceSummary) => void;
    h.create.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    await render(<CloudPurchaseProvider tabs="header">
      <BillingHeader /><CloudPurchaseTabs /><ManagedServerPurchase preserveProject />
    </CloudPurchaseProvider>);
    await click("Choose Starter");
    const monthly = buttons(copy.purchase.monthly)[0]!;
    const payg = buttons(copy.purchase.payg)[0]!;
    expect(payg.closest('fieldset')?.disabled).toBe(true);
    expect(buttons(copy.custom.name)[0]?.closest('fieldset')?.disabled).toBe(true);
    await act(async () => payg.click());
    expect(monthly.getAttribute("aria-selected")).toBe("true");
    await act(async () => finish(server));
    expect(h.create).toHaveBeenCalledOnce();
    expect(h.post).toHaveBeenCalledOnce();
  });

  it("opens the shared plans inside a destination dialog and preserves the project when dismissed", async () => {
    await render(<ModalProvider><AddServerFromProject /></ModalProvider>);
    await click("Add a destination");
    const dialog = document.querySelector('[role="dialog"]')!;
    expect([...dialog.querySelectorAll("article h3")].map(heading => heading.textContent)).toEqual(["Hobby", "Starter", "Pro", "Scale"]);
    expect(dialog.querySelector("header h2")?.textContent).toBe(baseDictionary.servers.setup.addServer);
    expect(h.create).not.toHaveBeenCalled(); expect(h.post).not.toHaveBeenCalled();
    await act(async () => dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(host.querySelector<HTMLInputElement>('input[aria-label="Project name"]')?.value).toBe("Keep this project");
  });

  it("creates a server with its default name only after a plan is chosen", async () => {
    await render(<ManagedServerPurchase preserveProject />);
    expect(planNames()).toEqual(["Hobby", "Starter", "Pro", "Scale"]);
    expect(host.querySelector('input:not([aria-label="Referral code"])')).toBeNull();
    expect(h.create).not.toHaveBeenCalled();
    expect(h.post).not.toHaveBeenCalled();
    await click("Choose Starter");
    expect(h.create).toHaveBeenCalledExactlyOnceWith({ name: copy.workspaces.defaultName });
  });

  it("keeps the landing-page plan using the live offer without creating anything on arrival", async () => {
    await render(<ManagedServerPurchase preserveProject requestedPlanId="starter" />);
    expect(planNames()).toEqual(["Starter"]);
    expect(h.create).not.toHaveBeenCalled();
    expect(h.post).not.toHaveBeenCalled();
    await click("Choose Starter");
    expect(h.create).toHaveBeenCalledOnce();
    expect(h.post).toHaveBeenCalledWith("billing/subscription", expect.objectContaining({ planTierId: "starter", workspaceId: server.id }));
  });

  it("lets the visitor compare other plans and safely ignores a removed or invalid requested plan", async () => {
    await render(<ManagedServerPurchase requestedPlanId="starter" />);
    await click(copy.plansRoute.otherPlans);
    expect(planNames()).toEqual(["Hobby", "Starter", "Pro", "Scale"]);
    await render(<ManagedServerPurchase requestedPlanId="not-a-live-plan" />);
    expect(planNames()).toEqual(["Hobby", "Starter", "Pro", "Scale"]);
    expect(h.create).not.toHaveBeenCalled();
    expect(h.post).not.toHaveBeenCalled();
  });

  it("continues the website's selected preset to checkout once, including Strict Mode effect replay", async () => {
    const key = "72e918ec-8d9c-4b81-bf43-7a5790ca239a";
    const page = () => <StrictMode><ManagedServerPurchase requestedPlanId="starter" autoCheckout checkoutIntent={key} /></StrictMode>;
    await render(page());
    expect(h.create).toHaveBeenCalledExactlyOnceWith({ name: copy.workspaces.defaultName, idempotencyKey: key });
    expect(h.post).toHaveBeenCalledExactlyOnceWith("billing/subscription", {
      planTierId: "starter", interval: "monthly", workspaceId: server.id, idempotencyKey: `${key}-starter-monthly`,
    });
    expect(window.location.href).toBe("https://checkout.example.test/new-server");
    expect(window.open).not.toHaveBeenCalled();
    await render(page());
    expect(h.create).toHaveBeenCalledOnce();
    expect(h.post).toHaveBeenCalledOnce();
  });

  it("waits for authentication and the live catalog before continuing a pricing selection", async () => {
    h.sessionPending = true;
    let finish!: (value: unknown) => void;
    h.get.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const page = () => <ManagedServerPurchase requestedPlanId="starter" autoCheckout />;
    await render(page());
    expect(h.create).not.toHaveBeenCalled();
    await act(async () => finish(catalog));
    expect(h.create).not.toHaveBeenCalled();
    h.sessionPending = false;
    await render(page());
    expect(h.create).toHaveBeenCalledOnce();
    expect(h.post).toHaveBeenCalledOnce();
  });

  it.each(["missing-plan", "free", "enterprise"])("does not substitute another checkout for an unavailable pricing selection (%s)", async requestedPlanId => {
    await render(<ManagedServerPurchase requestedPlanId={requestedPlanId} autoCheckout />);
    expect(host.textContent).toContain(copy.plansRoute.requestedPlanUnavailable);
    expect(h.create).not.toHaveBeenCalled();
    expect(h.post).not.toHaveBeenCalled();
  });

  it("continues the entry compute plan selected on pricing through the shared checkout", async () => {
    await render(<ManagedServerPurchase requestedPlanId="hobby" autoCheckout />);
    expect(h.create).toHaveBeenCalledOnce();
    expect(h.post).toHaveBeenCalledExactlyOnceWith("billing/subscription", expect.objectContaining({
      planTierId: "hobby", interval: "monthly", workspaceId: server.id,
    }));
  });

  it("keeps disabled purchases inactive even with an explicit pricing selection", async () => {
    await render(<ManagedServerPurchase requestedPlanId="starter" autoCheckout billingEnabled={false} />);
    expect(host.textContent).toContain(copy.plansRoute.billingUnavailable);
    expect(h.create).not.toHaveBeenCalled();
    expect(h.post).not.toHaveBeenCalled();
  });

  it("replays the same server and payment identities after an uncertain response and page reload", async () => {
    h.post.mockRejectedValueOnce(new Error("Lost payment response"));
    const page = () => <ManagedServerPurchase requestedPlanId="starter" autoCheckout />;
    await render(page());
    const key = new URL(window.location.href).searchParams.get("checkoutIntent");
    expect(key).toMatch(/^[a-f0-9-]{36}$/);
    expect(new URL(window.location.href).searchParams.get("organizationId")).toBe("org-a");
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Lost payment response");
    const originalCreate = h.create.mock.calls[0];
    const originalCheckout = h.post.mock.calls[0];
    await act(async () => root.unmount());
    root = createRoot(host);
    await render(page());
    expect(h.create.mock.calls[1]).toEqual(originalCreate);
    expect(h.post.mock.calls[1]).toEqual(originalCheckout);
  });

  it("requires a new choice after confirmed cancellation and keeps the server on refresh", async () => {
    const key = "72e918ec-8d9c-4b81-bf43-7a5790ca239a";
    window.location.href = `http://localhost:3000/billing/plans?newServer=1&plan=starter&startCheckout=1&checkoutIntent=${key}`;
    h.get.mockImplementation(async path => path === "billing/checkouts" ? { data: { items: [{
      id: "a".repeat(64), checkoutId: "cs_pending", server, kind: "subscription", name: "Starter", amountCents: 2000,
      currency: "usd", interval: "monthly", state: "open", canResume: true, canCancel: true,
    }] } } : catalog);
    h.post.mockRejectedValueOnce(new ApiError(409, "Already pending", { code: "CLOUD_WORKSPACE_CHECKOUT_PENDING" }));
    await render(<ManagedServerPurchase requestedPlanId="starter" autoCheckout checkoutIntent={key} />);
    const first = h.post.mock.calls[0][1].idempotencyKey;
    await click(copy.pendingPayments.cancel);
    h.post.mockResolvedValueOnce({ data: { status: "expired", checkoutId: "cs_pending", checkoutUrl: null } });
    await click(copy.pendingPayments.confirmCancel);
    const url = new URL(window.location.href);
    expect(url.searchParams.has("startCheckout")).toBe(false);
    expect(url.searchParams.get("checkoutIntent")).toBe(key);
    expect(url.searchParams.get("checkoutAttempt")).not.toBe(key);
    expect(h.post).toHaveBeenCalledTimes(2);
    await act(async () => root.unmount()); root = createRoot(host);
    await render(<ManagedServerPurchase requestedPlanId="starter" checkoutIntent={key} />);
    expect(h.post).toHaveBeenCalledTimes(2);
    await click("Choose Starter");
    expect(h.create.mock.calls[1]).toEqual(h.create.mock.calls[0]);
    expect(h.post.mock.calls[2][1].idempotencyKey).not.toBe(first);
    expect(h.post.mock.calls[2][1].workspaceId).toBe(server.id);
  });

  it("starts a fresh explicit purchase after removing the cancelled draft", async () => {
    const key = "72e918ec-8d9c-4b81-bf43-7a5790ca239a";
    window.location.href = `http://localhost:3000/billing/plans?newServer=1&startCheckout=1&checkoutIntent=${key}`;
    h.get.mockImplementation(async path => path === "billing/checkouts" ? { data: { items: [{
      id: "a".repeat(64), checkoutId: "cs_pending", server, kind: "subscription", name: "Starter", amountCents: 2000,
      currency: "usd", interval: "monthly", state: "open", canResume: true, canCancel: true,
    }] } } : catalog);
    h.post.mockRejectedValueOnce(new ApiError(409, "Already pending", { code: "CLOUD_WORKSPACE_CHECKOUT_PENDING" }));
    await render(<ManagedServerPurchase requestedPlanId="starter" autoCheckout checkoutIntent={key} />);
    await click(copy.pendingPayments.cancel);
    h.post.mockResolvedValueOnce({ data: { status: "expired", checkoutId: "cs_pending", checkoutUrl: null } });
    await click(copy.pendingPayments.confirmCancel);
    h.remove.mockResolvedValueOnce({ data: { accepted: true } });
    await click(copy.pendingPayments.deleteServer);
    await click(copy.workspaces.confirmDelete);
    expect(h.create).toHaveBeenCalledOnce();
    expect(new URL(window.location.href).searchParams.get("checkoutIntent")).not.toBe(key);
    expect(new URL(window.location.href).searchParams.has("startCheckout")).toBe(false);
    await click("Choose Starter");
    expect(h.create.mock.calls[1][0].idempotencyKey).not.toBe(key);
  });

  it("does not continue a pending pricing purchase in another account or organization", async () => {
    let finish!: (value: CloudWorkspaceSummary) => void;
    h.create.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const page = () => <ManagedServerPurchase requestedPlanId="starter" autoCheckout />;
    await render(page());
    expect(h.create).toHaveBeenCalledOnce();
    h.org = "org-b";
    await render(page());
    await act(async () => finish(server));
    expect(h.create).toHaveBeenCalledOnce();
    expect(h.post).not.toHaveBeenCalled();
  });

  it.each([false, true])("keeps checkout and the selected destination through the status handoff (popup blocked: %s)", async (blocked) => {
    if (blocked) vi.mocked(window.open).mockReturnValueOnce(null);
    let billing: BillingState = { tier: "free", status: "credit_exhausted", overQuota: true, subscription: null,
      currentPeriod: { start: null, end: null }, monthlyCreditLimit: 0, buildTimeMinutes: 0,
      balance: { total: 0, quotaLimit: 0, quotaUsed: 0, quotaRemaining: 0 },
      workspace: server, billing: { enabled: true } };
    h.get.mockImplementation(async path => path === "billing/state" ? { data: billing } : catalog);
    const location = window.location.href;
    await render(<ModalProvider><AddServerFromProject /></ModalProvider>);
    await click("Add a destination");
    await click("Choose Starter");
    expect(h.create).toHaveBeenCalledOnce();
    expect(h.post).toHaveBeenCalledExactlyOnceWith("billing/subscription", expect.objectContaining({ workspaceId: server.id }));
    expect(h.readServer).toHaveBeenCalledExactlyOnceWith(server.serverId);
    expect(h.selected).toHaveBeenCalledWith(expect.objectContaining({ id: server.serverId }));
    expect(h.get).toHaveBeenCalledWith("billing/state", { params: { workspaceId: server.id } });
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    expect(document.querySelector('[role="dialog"] article')).toBeNull();
    const link = document.querySelector<HTMLAnchorElement>('a[href="https://checkout.example.test/new-server"]');
    expect(link?.target).toBe("_blank");
    expect(link?.rel).toBe("noopener noreferrer");
    expect(window.location.href).toBe(location);
    await click(copy.deployGate.checkPlan);
    expect(document.body.textContent).toContain(copy.deployGate.pending);
    billing = { ...billing, tier: "hobby", status: "active", overQuota: false, plan: offer("hobby"), subscription: subscription("hobby") };
    await click(copy.deployGate.checkPlan);
    expect(document.body.textContent).toContain(copy.workspaces.serverPlanReady);
    expect(document.querySelector('a[href="https://checkout.example.test/new-server"]')).toBeNull();
    await click(copy.workspaces.returnToSetup);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(host.querySelector<HTMLInputElement>('input[aria-label="Project name"]')?.value).toBe("Keep this project");
    expect(h.post).toHaveBeenCalledOnce();
  });

  it("creates one explicit server and reuses it and the checkout attempt after an uncertain response", async () => {
    let created!: (value: CloudWorkspaceSummary) => void;
    h.create.mockReturnValueOnce(new Promise(resolve => { created = resolve; }));
    h.post.mockRejectedValueOnce(new Error("Checkout response lost"));
    const started = vi.fn();
    await render(<BillingWorkspaceProvider workspaceId="cws-already-paid"><ManagedServerPurchase preserveProject onCheckoutStarted={started} /></BillingWorkspaceProvider>);
    await act(async () => { buttons("Choose Starter")[0]!.click(); buttons("Choose Starter")[0]!.click(); });
    expect(h.create).toHaveBeenCalledExactlyOnceWith({ name: copy.workspaces.defaultName });
    expect(h.post).not.toHaveBeenCalled();
    await act(async () => created(server));
    expect(h.post).toHaveBeenCalledWith("billing/subscription", expect.objectContaining({ workspaceId: server.id, planTierId: "starter" }));
    expect(host.textContent).toContain("Checkout response lost");
    await click("Choose Starter");
    expect(h.create).toHaveBeenCalledOnce();
    expect(h.post.mock.calls[1]).toEqual(h.post.mock.calls[0]);
    expect(started).toHaveBeenCalledWith(server, "https://checkout.example.test/new-server");
    expect(popup.location.href).toBe("https://checkout.example.test/new-server");
    expect(popup.opener).toBeNull();
  });

  it("keeps the new server and exact purchase when retrying from unavailable-capacity feedback", async () => {
    h.post.mockRejectedValueOnce(new ApiError(503, "Unavailable", {
      code: "CLOUD_CAPACITY_UNAVAILABLE", error: "Raw provider failure",
    }));
    await render(<BillingWorkspaceProvider workspaceId="cws-already-paid"><ManagedServerPurchase preserveProject /></BillingWorkspaceProvider>);
    await click("Choose Pro");
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(copy.checkoutUnavailable.capacityTitle);
    expect(document.body.textContent).not.toContain("Raw provider failure");
    expect(popup.close).toHaveBeenCalledOnce();
    expect(h.post.mock.calls[0]![1]).toMatchObject({ workspaceId: server.id, planTierId: "pro" });
    await click(copy.checkoutUnavailable.retry);
    expect(h.create).toHaveBeenCalledOnce();
    expect(h.post.mock.calls[1]).toEqual(h.post.mock.calls[0]);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it.each([false, true])("recovers pending payment instead of a raw error and clears canceled purchase identity (delete server: %s)", async remove => {
    h.get.mockImplementation(async path => path === "billing/checkouts" ? { data: { items: [{
      id: "a".repeat(64), checkoutId: "cs_pending", server, kind: "subscription", name: "Saved Starter",
      amountCents: 2000, currency: "usd", interval: "monthly", state: "open", canResume: true, canCancel: true,
    }] } } : catalog);
    h.post.mockRejectedValueOnce(new ApiError(409, "Blocked", { code: "CLOUD_WORKSPACE_CHECKOUT_PENDING", error: "Raw pending error" }));
    h.post.mockImplementation(async path => path === "billing/checkout/cancel"
      ? { data: { status: "expired", checkoutId: "cs_pending", checkoutUrl: null } }
      : { data: { checkoutUrl: "https://checkout.example.test/new-server" } });
    h.remove.mockResolvedValue({ ...server, state: "deleting" });
    await render(<ManagedServerPurchase preserveProject />);
    await click("Choose Starter");
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(copy.pendingPayments.title);
    expect(document.body.textContent).not.toContain("Raw pending error");
    await click(copy.pendingPayments.cancel); await click(copy.pendingPayments.confirmCancel);
    if (remove) {
      await click(copy.pendingPayments.deleteServer); await click(copy.workspaces.confirmDelete);
      h.create.mockResolvedValueOnce({ ...server, id: "cws-replacement", serverId: "server-replacement" });
    }
    await act(async () => document.querySelector<HTMLButtonElement>(`button[aria-label="${copy.checkoutUnavailable.close}"]`)!.click());
    await click("Choose Starter");
    const attempts = h.post.mock.calls.filter(([path]) => path === "billing/subscription").map(([, input]) => input);
    expect(attempts).toHaveLength(2);
    expect(attempts[1].idempotencyKey).not.toBe(attempts[0].idempotencyKey);
    expect(attempts[1].workspaceId).toBe(remove ? "cws-replacement" : server.id);
    expect(h.create).toHaveBeenCalledTimes(remove ? 2 : 1);
  });

  it("discards an unavailable checkout when the customer changes organization", async () => {
    h.post.mockRejectedValueOnce(new ApiError(503, "Unavailable", { code: "OBLIEN_CHECKOUT_UNAVAILABLE" }));
    await render(<ManagedServerPurchase preserveProject />);
    await click("Choose Starter");
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(copy.checkoutUnavailable.checkoutTitle);
    h.org = "org-b";
    await render(<ManagedServerPurchase preserveProject />);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(h.post).toHaveBeenCalledOnce();
  });

  it("does not start checkout from an old organization after its server creation completes", async () => {
    let created!: (value: CloudWorkspaceSummary) => void;
    h.create.mockReturnValueOnce(new Promise(resolve => { created = resolve; }));
    const purchase = <ManagedServerPurchase preserveProject />;
    await render(purchase); await click("Choose Starter");
    h.org = "org-b";
    await render(<ManagedServerPurchase preserveProject />);
    await act(async () => created(server));
    expect(h.post).not.toHaveBeenCalled();
    expect(popup.close).toHaveBeenCalled();
    h.create.mockResolvedValueOnce({ ...server, id: "cws-org-b" });
    await click("Choose Starter");
    expect(h.post).toHaveBeenCalledWith("billing/subscription", expect.objectContaining({ workspaceId: "cws-org-b" }));
  });

  it("allows retrying a failed server creation without starting checkout prematurely", async () => {
    h.create.mockRejectedValueOnce(new Error("Server could not be created"));
    await render(<ManagedServerPurchase preserveProject />); await click("Choose Starter");
    expect(buttons("Choose Starter")[0]?.disabled).toBe(false);
    expect(host.textContent).toContain("Server could not be created");
    expect(h.post).not.toHaveBeenCalled();
    await click("Choose Starter");
    expect(h.create).toHaveBeenCalledTimes(2);
    expect(h.post).toHaveBeenCalledOnce();
  });

  it("reuses existing Cloud server linking on self-hosted installations", async () => {
    const availableServer = { id: server.serverId, name: "Existing managed server", connection: "cloud", managed: { ...server, state: "running" }, capabilities: {} };
    h.available.mockResolvedValueOnce({ servers: [availableServer] });
    h.connect.mockResolvedValueOnce({ ...server, state: "running" });
    const ready = vi.fn();
    await render(<ManagedServerSetup onReady={ready} />, true);
    expect(host.textContent).toContain("Existing managed server");
    expect(planNames()).toEqual([]);
    await click(baseDictionary.servers.acquire.useServer);
    expect(h.connect).toHaveBeenCalledExactlyOnceWith({ serverId: server.serverId });
    expect(ready).toHaveBeenCalledWith(expect.objectContaining({ id: server.id }), false);
    expect(h.create).not.toHaveBeenCalled(); expect(h.post).not.toHaveBeenCalled();
  });
});
