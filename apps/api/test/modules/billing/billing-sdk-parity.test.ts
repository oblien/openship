import { savedOffer as subscriptionOffer, savedMetadata as subscriptionMetadata } from "../../helpers/saved-cloud-offer";
import capacityCatalog from "../../fixtures/oblien-capacity-catalog.json";
import { monthlyCloudBilling } from "../../helpers/monthly-cloud-offer";
import managedTransfer from "../../fixtures/oblien-managed-transfer.json";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { OblienBillingApi, type OblienSubscription } from "@repo/platform/engine/lib/oblien-billing-api";
const provider = vi.hoisted(() => ({
  cloudMode: true,
  enabled: true,
  topups: true,
  checkout: vi.fn(),
  catalog: vi.fn(),
  monthlySupport: vi.fn(),
  entitlement: vi.fn(),
  balance: vi.fn(),
  namespaces: vi.fn(),
  portal: vi.fn(),
  subscription: vi.fn(),
  cancel: vi.fn(),
  resume: vi.fn(),
  subscriptions: new Map<string, OblienSubscription>(),
  cloudRequest: vi.fn(),
  quota: vi.fn(),
  resourceRead: vi.fn(),
  resourceUpdate: vi.fn(),
  resources: vi.fn(),
  workspace: vi.fn(),
  kickoff: vi.fn(),
  checkoutStatus: vi.fn(),
  support: vi.fn(),
  limits: new Map<string, Record<string, number | null>>(),
}));
vi.mock("@repo/platform/engine/config/env", async original => {
  const actual = await original<{ env: Record<string, unknown> }>();
  return { ...actual, env: { ...actual.env, get CLOUD_MODE() { return provider.cloudMode; }, get BILLING_ENABLED() { return provider.enabled; }, get BILLING_TOPUPS_ENABLED() { return provider.topups; } } };
});
vi.mock("@repo/platform/engine/lib/stripe-client", () => ({ stripe: () => { throw new Error("Direct Stripe billing is retired"); } }));
vi.mock("@repo/platform/engine/lib/oblien-client", () => ({
  getOblienBillingApi: () => ({
    assertResellerSupport: provider.support,
    assertMonthlyCapacitySupport: provider.monthlySupport,
    getCheckout: provider.checkoutStatus,
    getCatalog: provider.catalog,
    getEntitlement: provider.entitlement,
    getBalance: provider.balance,
    createCheckout: provider.checkout,
    createPortal: provider.portal,
    getSubscription: provider.subscription,
    cancelSubscription: provider.cancel,
    resumeSubscription: provider.resume,
    getDefaults: async () => ({
      success: true,
      autoApply: true,
      service: "workspace_vm",
      quotaLimit: 0,
      overdraft: 0,
      onOverdraftAction: "stop_workspaces",
      suspendThreshold: 0,
    }),
  }),
  getOblienClient: () => ({
    workspaces: { getQuota: provider.quota, get: provider.workspace },
    namespaces: {
      ensure: provider.namespaces,
      get: provider.resourceRead,
      update: provider.resourceUpdate,
    },
  }),
}));
vi.mock("@repo/platform/engine/lib/cloud/client", () => ({ cloudClient: () => ({ request: provider.cloudRequest }) }));
vi.mock("@repo/platform/engine/modules/billing/billing-resources.service", () => ({ getBillingResources: provider.resources }));
// No live workspace, network or worker is started in the transport tests. The
// real capacity service, admission transaction and deployment snapshots run.
vi.mock("@repo/platform/engine/lib/cloud-preflight", () => ({ runCloudPreflight: async () => ({ runtime: { ok: true } }) }));
vi.mock("@repo/platform/engine/lib/platform-config", async original => ({
  ...await original<typeof import("@repo/platform/engine/lib/platform-config")>(),
  platform: () => ({ target: "cloud", runtime: { name: "cloud", supports: () => false } }),
}));
vi.mock("@repo/platform/engine/modules/deployments/build-pipeline", async original => ({
  ...await original<typeof import("@repo/platform/engine/modules/deployments/build-pipeline")>(),
  kickoffBuild: provider.kickoff,
}));
import { db, schema, repos, seedOwner as seedBaseOwner, type SeededOwner } from "../jobs/_harness";
import { ensureNamespace } from "@repo/platform/engine/lib/openship-cloud";
import { AppError, CREDIT_PACKS, FREE_DOMAIN_SUFFIX, getAppTemplate } from "@repo/core";
import { createShip, type VerifiedIdentity } from "@repo/sdk/native";
import { OpenshipClient } from "@repo/sdk/client";
import { getPlatformKernel } from "@repo/platform/engine/lib/platform";
import { billingPlansRoutes, billingSaasRoutes } from "../../../src/modules/billing/billing.routes";
import { billingLocalRoutes } from "../../../src/modules/billing/billing-local.routes";
import { healthRoutes } from "../../../src/modules/health/health.routes";
import { handleApiError } from "../../../src/middleware/error-handler";
import * as repository from "@repo/platform/engine/modules/billing/billing.repository";
import { flushAudit } from "@repo/platform/engine/lib/audit-emitter";
import { eq } from "@repo/db";
import { presentCloudPlans } from "@repo/platform/engine/modules/billing/billing-catalog";
import { assertBuildMinutesAvailable } from "@repo/platform/engine/lib/plan-guard";
import { cloudRuntimeTarget } from "@repo/platform/engine/config/env";
import { encrypt } from "@repo/platform/engine/lib/encryption";
import { assertManagedServerCanWork } from "@repo/platform/engine/lib/cloud-workspace-access";
import type { BillingPendingCheckout, BillingPlanChange, BillingPlanChangeQuote } from "@repo/contracts";

const app = new Hono().onError(handleApiError)
  .use("*", async (c, next) => { c.set("clientIp", "192.0.2.64"); await next(); })
  .route("/api/health", healthRoutes).route("/api/billing", billingPlansRoutes).route("/api/billing", billingSaasRoutes);
const fetcher = ((url, init) => app.request(url as string, init)) as typeof fetch;
// Billing operations run through real HTTP/native authorization and per-server subscriptions.
// Provisioning and resize recovery are covered by the server lifecycle integration suite.
async function seedOwner(options?: Parameters<typeof seedBaseOwner>[0]) {
  const owner = await seedBaseOwner(options);
  await ensureNamespace(owner.orgId, null);
  return owner;
}
async function billingWorkspace(actor: SeededOwner) {
  return (await repos.cloudWorkspace.listByOrganization(actor.orgId))[0]!;
}
async function clients(actor: SeededOwner, organizationId = actor.orgId, limits: Partial<VerifiedIdentity> = {}) {
  const user = (await repos.user.findById(actor.userId))!;
  const ship = createShip({ platform: getPlatformKernel(), identity: { resolve: async () => ({ user, sessionId: "billing", ...limits }) } });
  return {
    native: (await ship.scope({ identity: "verified", organizationId })).billing,
    remote: new OpenshipClient({ baseUrl: "http://openship.test", token: actor.token, organizationId, fetch: fetcher }).billing,
  };
}
beforeEach(() => {
  provider.cloudMode = provider.enabled = provider.topups = true;
  provider.subscriptions.clear();
  provider.support.mockResolvedValue(undefined);
  provider.monthlySupport.mockResolvedValue(capacityCatalog);
  provider.limits.clear();
  provider.kickoff.mockResolvedValue("simulated-worker");
  provider.quota.mockResolvedValue({ success: true, limits: { cpus: 32, memory_mb: 65536, disk_size_mb: 1048576 }, maxSandboxes: null });
  provider.resourceRead.mockImplementation(async (slug: string) => ({ data: { id: slug, slug, resource_limits: provider.limits.get(slug) } }));
  provider.resourceUpdate.mockImplementation(async (slug: string, input: { resource_limits: Record<string, number | null> }) => {
    provider.limits.set(slug, input.resource_limits);
    return { data: { id: slug, slug, resource_limits: input.resource_limits } };
  });
  provider.namespaces.mockImplementation(async ({ slug, resource_limits }) => {
    provider.limits.set(slug, resource_limits);
    return { data: { id: slug, slug, resource_limits } };
  });
  provider.checkoutStatus.mockResolvedValue({ checkout: { status: "open", fulfilled: false } });
  provider.checkout.mockResolvedValue({ success: true, url: "https://checkout.stripe.com/private-session", checkoutId: "cs_test" });
  provider.entitlement.mockImplementation(async (namespace) => ({
    success: true, namespace, tierId: provider.subscriptions.get(namespace)?.tierId ?? null, status: provider.subscriptions.has(namespace) ? "active" : "credit_exhausted",
    periodStart: provider.subscriptions.get(namespace)?.periodStart ?? null, periodEnd: provider.subscriptions.get(namespace)?.periodEnd ?? null,
    quota: { limit: provider.subscriptions.has(namespace) ? 1200 : 0, used: 0, balance: provider.subscriptions.has(namespace) ? 1200 : 0 },
  }));
  provider.portal.mockImplementation(async ({ namespace }) => ({ success: true, namespace, url: `https://billing.stripe.com/p/session/private-${namespace}` }));
  provider.subscription.mockImplementation(async namespace => ({ success: true, namespace, subscription: provider.subscriptions.get(namespace) ?? null }));
  for (const [method, cancelAtPeriodEnd] of [[provider.cancel, true], [provider.resume, false]] as const) {
    method.mockImplementation(async namespace => {
      const old = provider.subscriptions.get(namespace);
      if (!old) throw new AppError("No subscription", 404, "OBLIEN_BILLING_ERROR");
      const subscription = { ...old, cancelAtPeriodEnd };
      provider.subscriptions.set(namespace, subscription);
      return { success: true, namespace, subscription };
    });
  }
  provider.catalog.mockResolvedValue({
    success: true,
    // Deliberately stale provider prices: customer offers come from Openship.
    plans: [
      { tierId: "hobby", name: "Hobby", priceMonthly: 10, priceYearly: 100, currency: "usd", creditsPerCycle: 1200, yearlyCreditsPerCycle: 14400, features: [] },
      { tierId: "pro", name: "Pro", priceMonthly: 29, priceYearly: 290, currency: "usd", creditsPerCycle: 3000, yearlyCreditsPerCycle: 36000, features: [] },
    ],
    creditPacks: [
      { packId: "pack_5k", name: "Starter", credits: 1000, price: 10, currency: "usd" },
    ],
  });
});

afterEach(async () => {
  await flushAudit();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await db.delete(schema.creditPack);
});

describe("billing through the same SDK and HTTP application operations", () => {
  it.each([false, true])("keeps monthly billing and workload access with unlimited transfer=%s in both transports", async unlimited => {
    const owner = await seedOwner(), other = await seedOwner();
    const selected = await billingWorkspace(owner);
    const monthly = monthlyCloudBilling(owner.orgId, selected.namespace!);
    monthly.entitlement.capacity!.retention.amountDue = 1.25;
    monthly.entitlement.capacity!.network = { ...managedTransfer, service: "managed_proxy_transfer", status: "active", unlimited,
      includedBytes: unlimited ? null : managedTransfer.includedBytes,
      includedAvailableBytes: unlimited ? null : managedTransfer.includedAvailableBytes,
      availableBytes: unlimited ? null : managedTransfer.availableBytes };
    // Exercise the actual SDK/validator before the shared application operation;
    // a mock entitlement alone missed the provider's newly included transfer.
    const billing = new OblienBillingApi({ clientId: "test-id", clientSecret: "test-secret",
      fetch: (async url => Response.json(new URL(String(url)).pathname === "/billing/balance"
        ? monthly.balance : monthly.entitlement)) as typeof fetch });
    provider.subscriptions.set(selected.namespace!, monthly.subscription);
    provider.entitlement.mockImplementation(async namespace => namespace === selected.namespace
      ? billing.getEntitlement(namespace) : { success: true, namespace, tierId: null, status: "credit_exhausted",
        periodStart: null, periodEnd: null, quota: { limit: 0, used: 0, balance: 0 } });
    provider.balance.mockImplementation(namespace => billing.getBalance(namespace));
    const c = await clients(owner), unrelated = await clients(other);
    for (const client of [c.native, c.remote]) {
      expect(await client.getState({ workspaceId: selected.id })).toMatchObject({
        tier: "pro", status: "active", overQuota: false, creditAlert: null, monthlyCreditLimit: null,
        balance: { quotaLimit: null, quotaRemaining: null, quotaUsed: 0, unlimited: false },
        compute: { billingMode: "monthly", covered: true, currentPeriod: { end: "2026-11-01T00:00:00Z" },
          retention: { amountDue: 1.25 }, network: { included: true, unlimited, status: "active",
            availableBytes: unlimited ? null : managedTransfer.availableBytes, periodConsumedBytes: managedTransfer.periodConsumedBytes } },
        topups: { available: false, status: "unavailable" },
        plan: { billingMode: "monthly", price: { monthly: 3900 }, monthlyCredits: null },
      });
      await expect(client.createTopup({ workspaceId: selected.id, packId: "pack_400" }))
        .rejects.toMatchObject({ code: "BILLING_TOPUPS_NOT_APPLICABLE" });
    }
    for (const client of [unrelated.native, unrelated.remote]) {
      expect((await client.getState()).compute).toBeNull();
      await expect(client.getState({ workspaceId: selected.id })).rejects.toMatchObject({ statusCode: 404 });
    }
    await expect(assertManagedServerCanWork(owner.orgId, selected.id)).resolves.toBeUndefined();
    await expect(assertManagedServerCanWork(other.orgId, selected.id)).rejects.toMatchObject({ statusCode: 404 });
    // Internet exhaustion does not cancel paid compute; expired compute still
    // blocks work even if the contract's transfer benefit remains unlimited.
    monthly.entitlement.capacity!.network.status = "blocked";
    monthly.entitlement.capacity!.network.availableBytes = 0;
    await expect(assertManagedServerCanWork(owner.orgId, selected.id)).resolves.toBeUndefined();
    monthly.entitlement.computeCovered = monthly.entitlement.capacity!.computeCovered = false;
    monthly.balance.computeCovered = false;
    monthly.balance.blocking = true;
    await expect(assertManagedServerCanWork(owner.orgId, selected.id)).rejects.toMatchObject({ code: "CLOUD_BILLING_BLOCKED" });
    expect(provider.checkout).not.toHaveBeenCalled();
  });

  it("does not present a linked installation's missing counters as zero server usage", async () => {
    const owner = await seedOwner(), c = await clients(owner);
    const workspace = await billingWorkspace(owner);
    const activity = { id: crypto.randomUUID(), controllerId: "linked-controller", scope: "project:linked",
      startedAt: new Date().toISOString() };
    const projects = [{ id: "linked-project", name: "Managed from self-hosted" }];
    await repos.cloudWorkspace.claimActivity(workspace.id, owner.orgId, activity, false, projects);
    await repos.cloudWorkspace.releaseActivity(workspace.id, owner.orgId, activity.id, activity.controllerId, projects);
    for (const client of [c.native, c.remote]) {
      const state = await client.getState();
      expect(state.buildTimeMinutes).toBeNull();
      for (const key of ["routes", "buildMinutes", "services", "projects"] as const)
        expect(state.capacity?.[key]?.used).toBeNull();
      expect(state.balance.quotaUsed).toBe(0);
    }
  });

  it("reports a Supabase draft as one project and zero services, then tracks its deployment reservation", async () => {
    const owner = await seedOwner(),
      c = await clients(owner);
    await c.native.getState();
    const namespace = (await billingWorkspace(owner)).namespace!;
    provider.subscriptions.set(namespace, {
      tierId: "scale",
      status: "active",
      billingInterval: "monthly",
      periodStart: "2026-09-27T00:00:00Z",
      periodEnd: "2026-10-27T00:00:00Z",
      cancelAtPeriodEnd: false,
      canceledAt: null,
    });
    provider.resourceRead.mockImplementation(async (slug: string) => ({
      success: true,
      data: {
        slug,
        effective_resource_limits: {
          max_workspaces: 12,
          max_total_vcpus: 8,
          max_total_ram_mb: 16384,
          max_total_disk_gb: 256,
        },
        allocated_resource_usage: {
          workspaces: 0,
          vcpus: 0,
          ram_mb: 0,
          disk_gb: 0,
          pending_updates: 0,
        },
      },
    }));
    const groupId = `group-${owner.orgId}`,
      projectId = `project-${owner.orgId}`;
    await db
      .insert(schema.projectGroup)
      .values({ id: groupId, organizationId: owner.orgId, name: "Supabase", slug: "supabase" });
    await db.insert(schema.project).values({
      id: projectId,
      groupId,
      organizationId: owner.orgId,
      name: "Supabase",
      slug: "supabase",
      serverId: (await repos.server.findByWorkspace((await billingWorkspace(owner)).id, owner.orgId))!.id,
      isApp: true,
      appTemplateId: "supabase",
    });
    const services = [];
    for (const spec of getAppTemplate("supabase")!.services!) {
      services.push(
        await repos.service.create({ projectId, name: spec.name, image: spec.image, enabled: true }),
      );
    }
    expect(services).toHaveLength(9);
    const expectSlots = async (used: number) => {
      for (const client of [c.native, c.remote]) {
        expect(await client.getState()).toMatchObject({
          tier: "team",
          balance: { quotaUsed: 0 },
          capacity: {
            services: { used, max: null },
            projects: { used: 1, max: null },
            workspaces: { used: 0, max: 12 },
            vcpus: { used: 0, max: 8 },
            ramMb: { used: 0, max: 16384 },
            diskGb: { used: 0, max: 256 },
          },
        });
      }
    };
    await expectSlots(0);
    const deploymentId = `deployment-${owner.orgId}`;
    await db.insert(schema.deployment).values({
      id: deploymentId,
      projectId,
      organizationId: owner.orgId,
      branch: "main",
      status: "queued",
      meta: {
        cloudApplicationSlot: false,
        cloudServiceSlots: services.map((service) => service.name),
      },
    });
    await expectSlots(services.length);
    await repos.deployment.updateStatus(deploymentId, "failed");
    await expectSlots(0);
    expect(await repos.service.listByProject(projectId)).toHaveLength(services.length);
  });

  it("verifies a checkout only inside its authenticated organization in both transports", async () => {
    const owner = await seedOwner(),
      other = await seedOwner();
    const a = await clients(owner),
      b = await clients(other);
    await a.native.getState();
    await b.native.getState();
    const namespace = (await billingWorkspace(owner)).namespace!;
    provider.checkoutStatus.mockImplementation(async (slug: string, id: string) => {
      if (slug !== namespace || id !== "cs_owned")
        throw new AppError("Checkout not found", 404, "BILLING_CHECKOUT_NOT_FOUND");
      return {
        success: true,
        namespace: slug,
        checkout: {
          id,
          kind: "topup",
          status: "complete",
          paymentStatus: "paid",
          fulfillmentStatus: "completed",
          fulfilled: true,
          namespaceCreditsGranted: 5000,
        },
      };
    });
    for (const client of [a.native, a.remote]) {
      expect(await client.getCheckout({ checkoutId: "cs_owned" })).toMatchObject({
        id: "cs_owned",
        creditsGranted: 5_000_000,
        fulfilled: true,
      });
      await expect(client.getCheckout({ checkoutId: "../cs_owned" })).rejects.toMatchObject({
        statusCode: 400,
      });
    }
    for (const client of [b.native, b.remote])
      await expect(client.getCheckout({ checkoutId: "cs_owned" })).rejects.toMatchObject({
        statusCode: 404,
      });
    expect((await app.request("/api/billing/checkout?checkoutId=cs_owned")).status).toBe(401);
  });
  it("loads a linked installation's prices from the SaaS without sending local credentials or using stale prices", async () => {
    const c = await clients(await seedOwner());
    provider.cloudMode = false;
    const data = presentCloudPlans("de");
    data.plans.find((plan) => plan.id === "starter")!.price.monthly = 2300;
    const publicFetch = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({ data }),
    );
    vi.stubGlobal("fetch", publicFetch);
    for (const client of [c.native, c.remote])
      expect(await client.listPlans({ locale: "de" })).toEqual(data);
    expect(publicFetch).toHaveBeenLastCalledWith(
      expect.any(URL),
      expect.objectContaining({ credentials: "omit", redirect: "error" }),
    );
    expect(publicFetch.mock.calls[0]![0].toString()).toBe(
      "https://api.openship.io/api/billing/plans?locale=de",
    );
    expect(publicFetch.mock.calls[0]![1]).not.toHaveProperty("headers");
    publicFetch.mockResolvedValue(Response.json({ data: { plans: [] } }));
    for (const client of [c.native, c.remote])
      await expect(client.listPlans()).rejects.toMatchObject({
        code: "BILLING_CATALOG_UNAVAILABLE",
      });
    expect(provider.cloudRequest).not.toHaveBeenCalled();
  });
  it("keeps resource telemetry behind the same organization and billing-read grant in the SDK and HTTP API", async () => {
    const owner = await seedOwner(), stranger = await seedOwner();
    const c = await clients(owner);
    const period = { start: "2026-09-01T00:00:00Z", end: "2026-10-01T00:00:00Z" };
    const resource = { measuredAt: "2026-09-19T00:00:00Z",
      compute: { status: "available", period, cpuHours: 2, memoryGbHours: 4, diskIoGb: .25, networkGb: 1.5 },
      edge: { status: "available", period, limits: { bandwidthGb: 50 }, requests: 130, bandwidthGb: 3.5, inboundGb: 1, outboundGb: 2.5 },
    };
    provider.resources.mockResolvedValue(resource);
    expect(await c.native.getResources()).toEqual(resource);
    expect(await c.remote.getResources()).toEqual(resource);
    expect(provider.resources).toHaveBeenCalledTimes(2);
    expect(provider.resources).toHaveBeenLastCalledWith(owner.orgId, undefined);
    await expect(clients(stranger, owner.orgId)).rejects.toMatchObject({ statusCode: 404 });
    const forbidden = new OpenshipClient({ baseUrl: "http://openship.test", token: stranger.token, organizationId: owner.orgId, fetch: fetcher });
    // HTTP rejects the foreign organization at the PAT's organization binding;
    // native scope resolution rejects it at the membership boundary above.
    await expect(forbidden.billing.getResources()).rejects.toMatchObject({ statusCode: 403 });
    const noSession = await app.request("/api/billing/resources");
    expect(noSession.status).toBe(401);
    expect(provider.resources).toHaveBeenCalledTimes(2);
  });
  it("starts each customer with a distinct namespace, no subscription and zero included Cloud compute", async () => {
    const owners = [await seedOwner(), await seedOwner()];
    const namespaces = new Set<string>();
    for (const owner of owners) {
      const c = await clients(owner);
      for (const client of [c.native, c.remote]) {
        expect(await client.getState()).toMatchObject({
          tier: "free", plan: null, subscription: null, monthlyCreditLimit: 0,
          balance: { quotaLimit: 0, quotaUsed: 0, quotaRemaining: 0, unlimited: false },
          capacity: { buildMinutes: { used: 0, max: 0 }, services: { max: 0 }, projects: { max: 0 } },
          maxServiceMachine: null, topups: { available: false, status: "unavailable" },
        });
        for (const pack of CREDIT_PACKS)
          await expect(client.createTopup({ packId: pack.id })).rejects.toMatchObject({
            statusCode: 402, code: "CLOUD_PLAN_REQUIRED",
          });
      }
      namespaces.add((await billingWorkspace(owner)).namespace!);
    }
    expect(namespaces.size).toBe(2);
    expect(provider.namespaces).toHaveBeenCalledTimes(2);
    expect(provider.checkout).not.toHaveBeenCalled();
    expect(provider.quota).not.toHaveBeenCalled();
  });

  it.each([["3", 1, 1024, "medium"], ["4", 2, 3072, "custom"]] as const)(
    "shows the purchased v%s service ceiling through both SDK and HTTP billing state", async (version, cpuCores, memoryMb, machineTier) => {
      const owner = await seedOwner(), c = await clients(owner);
      await c.native.getState();
      const namespace = (await billingWorkspace(owner)).namespace!;
      const metadata: Record<string, string> = { ...subscriptionMetadata("starter", owner.orgId, namespace), openship_offer_version: version };
      if (version === "3") {
        const limits = JSON.parse(metadata.openship_limits!);
        delete limits.maxServiceResources;
        metadata.openship_limits = JSON.stringify(limits);
      }
      const saved: NonNullable<OblienSubscription> = {
        tierId: "reseller", status: "active", billingInterval: "monthly", cancelAtPeriodEnd: false, canceledAt: null,
        periodStart: "2026-09-01T00:00:00Z", periodEnd: "2026-10-01T00:00:00Z",
        offer: { ...subscriptionOffer("starter", "monthly"), reference: `openship:starter:v${version}` }, metadata,
      };
      const before = structuredClone(saved);
      provider.subscriptions.set(namespace, saved);
      provider.resourceUpdate.mockClear();
      for (const client of [c.native, c.remote]) {
        const state = await client.getState();
        expect(state.maxServiceMachine).toEqual({ tier: machineTier, cpuCores, memoryMb });
        expect(state.plan?.limits).toEqual(JSON.parse(metadata.openship_limits!));
        expect(state.plan?.price.monthly).toBe(saved.offer!.unitAmount);
        expect(state.plan?.monthlyCredits).toBe(saved.offer!.credits * 1000);
      }
      expect(provider.subscriptions.get(namespace)).toEqual(before);
      expect(provider.resourceUpdate).not.toHaveBeenCalled();
    },
  );

  it("keeps allocated-server identity visible when the subscription ended and live capacity is unavailable", async () => {
    const owner = await seedOwner(), c = await clients(owner);
    const workspace = await billingWorkspace(owner);
    await db.insert(schema.cloudDockerWorkspace).values({
      ownerWorkspaceId: workspace.id, namespace: workspace.namespace!, provisionKey: `test-${workspace.id}`,
      workspaceId: `provider-${workspace.id}`, image: "ubuntu:24.04", state: "ready",
      resources: { cpuCores: 1, memoryMb: 4096, diskMb: 25600 },
    });
    provider.resourceRead.mockRejectedValue(new Error("Capacity unavailable"));
    for (const client of [c.native, c.remote]) {
      expect(await client.getState()).toMatchObject({
        workspace: { id: workspace.id, provisioned: true }, tier: "free", subscription: null,
        balance: { quotaUsed: 0, quotaRemaining: 0 },
      });
    }
    expect(provider.checkout).not.toHaveBeenCalled();
    expect(provider.resourceUpdate).not.toHaveBeenCalled();
  });

  it("keeps saved contract details visible when the provider cancels spending access", async () => {
    const owner = await seedOwner(), c = await clients(owner);
    const namespace = (await billingWorkspace(owner)).namespace!;
    const saved: NonNullable<OblienSubscription> = {
      tierId: "reseller", status: "active", billingInterval: "monthly", cancelAtPeriodEnd: false, canceledAt: null,
      periodStart: "2026-09-01T00:00:00Z", periodEnd: "2026-10-01T00:00:00Z",
      offer: subscriptionOffer("starter", "monthly"), metadata: subscriptionMetadata("starter", owner.orgId, namespace),
    };
    provider.subscriptions.set(namespace, saved);
    provider.entitlement.mockResolvedValue({
      success: true, namespace, tierId: saved.tierId, status: "canceled",
      periodStart: saved.periodStart, periodEnd: saved.periodEnd, quota: { limit: 0, used: 0, balance: 0 },
    });
    for (const client of [c.native, c.remote]) {
      expect(await client.getState()).toMatchObject({
        tier: "starter", status: "canceled", plan: { price: { monthly: saved.offer!.unitAmount } },
        subscription: { tier: "starter" }, balance: { quotaRemaining: 0 }, topups: { available: false },
        capabilities: { subscriptionChange: false },
      });
    }
    expect(provider.resourceUpdate).not.toHaveBeenCalled();
    expect(provider.checkout).not.toHaveBeenCalled();
  });

  it("never presents an unsubscribed namespace with a missing policy as unlimited", async () => {
    provider.entitlement.mockImplementation(async namespace => ({
      success: true, namespace, tierId: null, status: "active", periodStart: null, periodEnd: null,
      quota: { limit: null, used: 0, balance: null },
    }));
    const c = await clients(await seedOwner());
    for (const client of [c.native, c.remote]) {
      const state = await client.getState();
      expect(state.monthlyCreditLimit).toBe(0);
      expect(state.balance).toMatchObject({ quotaLimit: null, quotaRemaining: null, unlimited: false });
      expect(await client.createSubscription({ planTierId: "starter", interval: "monthly", idempotencyKey: "parity-starter-checkout" })).toHaveProperty("checkoutUrl");
    }
  });

  it("keeps account billing usable when plan discovery is unavailable", async () => {
    provider.catalog.mockRejectedValue(new AppError("Catalog unavailable", 503, "OBLIEN_BILLING_UNAVAILABLE"));
    const owner = await seedOwner(), c = await clients(owner);
    expect(await c.native.getState()).toMatchObject({ tier: "free", plan: null, monthlyCreditLimit: 0 });
    expect(provider.catalog).not.toHaveBeenCalled();
    const namespace = (await billingWorkspace(owner)).namespace!;
    provider.subscriptions.set(namespace, {
      tierId: "hobby", status: "active", billingInterval: "monthly", periodStart: "2026-09-01T00:00:00Z", periodEnd: "2026-10-01T00:00:00Z", cancelAtPeriodEnd: false, canceledAt: null,
    });
    for (const client of [c.native, c.remote]) {
      expect(await client.getState()).toMatchObject({ tier: "starter", plan: null, monthlyCreditLimit: null, balance: { quotaRemaining: 1_200_000, unlimited: false }, capabilities: { portal: true, cancellation: true } });
      await expect(client.createSubscription({ planTierId: "starter", interval: "monthly", idempotencyKey: "parity-starter-checkout" }))
        .rejects.toMatchObject({ code: "BILLING_PLAN_CHANGE_UNAVAILABLE" });
    }
    expect(provider.catalog).not.toHaveBeenCalled();
    expect(provider.checkout).not.toHaveBeenCalled();
  });

  it.each(["active", "canceled"] as const)("identifies uncapped credits only for a verified active enterprise subscription (%s)", async status => {
    const owner = await seedOwner(), c = await clients(owner);
    await c.native.getState();
    const namespace = (await billingWorkspace(owner)).namespace!;
    const subscription: NonNullable<OblienSubscription> = {
      tierId: "enterprise", status, billingInterval: "monthly", periodStart: "2026-09-01T00:00:00Z", periodEnd: "2026-10-01T00:00:00Z", cancelAtPeriodEnd: false, canceledAt: null,
    };
    provider.subscriptions.set(namespace, subscription);
    provider.entitlement.mockResolvedValue({ success: true, namespace, tierId: subscription.tierId, status, periodStart: subscription.periodStart, periodEnd: subscription.periodEnd, quota: { limit: null, used: 10, balance: null } });
    for (const client of [c.native, c.remote]) expect((await client.getState()).balance.unlimited).toBe(status === "active");
  });

  it("preserves a live subscription through SDK and HTTP even when capacity reads fail", async () => {
    provider.resourceRead.mockRejectedValue(new Error("Workspace resource operations unavailable"));
    provider.resourceUpdate.mockRejectedValue(new Error("Workspace resource operations unavailable"));
    const owner = await seedOwner(), c = await clients(owner);
    // First visit must onboard the namespace despite the unlimited reseller quota.
    expect((await c.remote.getState()).billing.enabled).toBe(true);
    expect(provider.entitlement).toHaveBeenCalledTimes(1);
    expect(provider.subscription).toHaveBeenCalledTimes(1);
    expect(provider.quota).not.toHaveBeenCalled();
    const namespace = (await billingWorkspace(owner)).namespace!;
    provider.subscriptions.set(namespace, {
      tierId: "pro", status: "active", billingInterval: "monthly", periodStart: "2026-09-01T00:00:00Z", periodEnd: "2026-10-01T00:00:00Z",
      cancelAtPeriodEnd: false, canceledAt: null,
    });
    for (const client of [c.native, c.remote]) {
      expect(await client.getState()).toMatchObject({ tier: "pro", billing: { enabled: true }, subscription: { tier: "pro" }, capabilities: { subscriptionChange: false } });
      await expect(client.createSubscription({ planTierId: "starter", interval: "monthly", idempotencyKey: "parity-starter-checkout" }))
        .rejects.toMatchObject({ code: "BILLING_PLAN_CHANGE_UNAVAILABLE" });
    }
    expect(provider.entitlement).toHaveBeenCalledTimes(5);
    expect(provider.subscription).toHaveBeenCalledTimes(5);
    expect(provider.quota).not.toHaveBeenCalled();
    expect(provider.resourceRead).toHaveBeenCalled();
    expect(provider.resourceUpdate).not.toHaveBeenCalled();
    expect(provider.checkout).not.toHaveBeenCalled();
  });

  it("does not depend on an owner capacity read to sell a declared namespace policy", async () => {
    const c = await clients(await seedOwner());
    provider.quota.mockImplementation(() => { throw new Error("Client capacity reads are forbidden"); });
    for (const client of [c.native, c.remote]) {
      expect(await client.createSubscription({ planTierId: "team", interval: "monthly", idempotencyKey: "parity-team-checkout" })).toHaveProperty("checkoutUrl");
      expect((await client.getState()).billing.enabled).toBe(true);
      expect(await client.createPortal()).toHaveProperty("portalUrl");
    }
    expect(provider.quota).not.toHaveBeenCalled();
    expect(provider.checkout).toHaveBeenCalledTimes(2);
    for (const [input] of provider.checkout.mock.calls) {
      expect(input.offer.resourceLimits).toEqual({ max_workspaces: 1, max_vcpus: 8, max_ram_mb: 32768, max_disk_gb: 600, max_total_vcpus: 8, max_total_ram_mb: 32768, max_total_disk_gb: 600 });
    }
  });

  it("still refuses checkout when the customer's subscription cannot be verified", async () => {
    provider.subscription.mockRejectedValue(new AppError("Namespace subscription unavailable", 503, "OBLIEN_BILLING_UNAVAILABLE"));
    const c = await clients(await seedOwner());
    for (const client of [c.native, c.remote]) {
      await expect(client.createSubscription({ planTierId: "starter", interval: "monthly", idempotencyKey: "parity-starter-checkout" })).rejects.toMatchObject({ code: "OBLIEN_BILLING_UNAVAILABLE" });
      await expect(client.createTopup({ packId: CREDIT_PACKS[0]!.id })).rejects.toMatchObject({
        code: "OBLIEN_BILLING_UNAVAILABLE",
      });
    }
    expect(provider.checkout).not.toHaveBeenCalled();
  });

  it("keeps localized plan discovery public and preserves monetary units and catalog secrecy", async () => {
    const c = await clients(await seedOwner());
    const remote = new OpenshipClient({ baseUrl: "http://openship.test", fetch: fetcher });
    const native = await c.native.listPlans({ locale: "ar" });
    expect(await remote.billing.listPlans({ locale: "ar" })).toEqual(native);
    expect(native.locale).toBe("ar");
    for (const [id, monthlyPrice, monthlyCredits] of [
      ["hobby", 1200, null],
      ["starter", 2400, null],
      ["pro", 4700, null],
      ["team", 11900, null],
    ] as const)
      expect(native.plans.find(plan => plan.id === id)).toMatchObject({
        price: { monthly: monthlyPrice, annual: null },
        monthlyCredits,
        annualCredits: null,
        limits: { buildMinutesPerMonth: null },
      });
    expect(JSON.stringify(native)).not.toMatch(/stripeCouponEnv|oblienLimits|STRIPE_PRICE/);
    const response = await app.request("/api/billing/plans", { headers: { "Accept-Language": "de" } });
    expect(response.headers.get("Vary")).toBe("Accept-Language");
    expect((await response.json()).data.locale).toBe("de");
    expect(provider.checkout).not.toHaveBeenCalled();
  });

  it.each([
    ["hobby", 1200, 0],
    ["starter", 2400, 0],
    ["pro", 4700, 0],
    ["team", 11900, 0],
  ] as const)("uses the selected tenant and current %s offer without auditing checkout URLs", async (tier, unitAmount, credits) => {
    const owner = await seedOwner(), other = await seedOwner(), c = await clients(owner);
    await db.update(schema.organization).set({ planTierId: "team" }).where(eq(schema.organization.id, other.orgId));
    expect(await c.native.getState()).toEqual(await c.remote.getState());
    expect((await c.native.getState()).tier).toBe("free");
    for (const client of [c.native, c.remote]) {
      expect(await client.createSubscription({ planTierId: tier, interval: "monthly", idempotencyKey: `parity-${tier}-checkout` })).toEqual({ checkoutUrl: "https://checkout.stripe.com/private-session" });
    }
    const managed = await billingWorkspace(owner);
    expect(managed.namespace).toBeTruthy();
    for (const [input] of provider.checkout.mock.calls) {
      expect(input).toMatchObject({
        namespace: managed.namespace,
        kind: "subscription",
        offer: { reference: `openship:${tier}:v13`, unitAmount, credits, billingMode: "monthly" },
        billingInterval: "monthly",
        metadata: { openship_organization: owner.orgId, openship_namespace: managed.namespace, openship_offer_version: "13" },
      });
      expect(input).not.toHaveProperty("customer");
      expect(input).not.toHaveProperty("line_items");
    }
    await flushAudit();
    const events = await db.select().from(schema.auditEvent).where(eq(schema.auditEvent.organizationId, owner.orgId));
    expect(events.filter(row => row.eventType === "billing:write")).toHaveLength(2);
    expect(events.every(row => row.actorUserId === owner.userId)).toBe(true);
    expect(JSON.stringify(events)).not.toContain("private-session");
  });

  it("shares annual catalog, custom quotes and exact yearly checkout terms across native and HTTP", async () => {
    provider.monthlySupport.mockResolvedValue({ ...capacityCatalog, resellerSubscriptionIntervals: ["monthly", "yearly"] });
    const owner = await seedOwner(), c = await clients(owner);
    expect((await c.native.listPlans()).annual.enabled).toBe(true);
    expect(await c.remote.listPlans()).toEqual(await c.native.listPlans());
    expect((await c.native.listPlans()).plans.find(plan => plan.id === "hobby")?.price).toEqual({ monthly: 1200, annual: 12000 });
    const resources = { cpuCores: 1, memoryMb: 4096, diskGb: 50 };
    const annual = await c.native.quoteCustomPlan({ ...resources, interval: "annual" });
    expect(await c.remote.quoteCustomPlan({ ...resources, interval: "annual" })).toEqual(annual);
    expect(annual).toMatchObject({ priceCents: 12000, interval: "annual" });
    const monthly = await c.remote.quoteCustomPlan(resources);
    for (const client of [c.native, c.remote]) {
      await expect(client.createSubscription({ planTierId: annual.basePlanTierId, interval: "annual",
        custom: { resources, quoteReference: monthly.reference }, idempotencyKey: "wrong-interval-checkout" }))
        .rejects.toMatchObject({ code: "BILLING_QUOTE_CHANGED" });
    }
    expect(provider.checkout).not.toHaveBeenCalled();
    for (const client of [c.native, c.remote]) {
      await client.createSubscription({ planTierId: annual.basePlanTierId, interval: "annual",
        custom: { resources, quoteReference: annual.reference }, idempotencyKey: "annual-custom-checkout" });
    }
    const workspace = await billingWorkspace(owner);
    for (const [input] of provider.checkout.mock.calls) expect(input).toMatchObject({
      namespace: workspace.namespace, kind: "subscription", billingInterval: "yearly",
      offer: { reference: annual.reference, unitAmount: 12000, credits: 0, billingMode: "monthly" },
      metadata: { openship_organization: owner.orgId, openship_namespace: workspace.namespace },
    });
  });

  it("enforces membership, billing grants, read-only limits and feature switches before provider calls", async () => {
    const owner = await seedOwner(), member = await seedOwner({ bound: false });
    await db.insert(schema.member).values({ id: `billing-${member.userId}`, organizationId: owner.orgId, userId: member.userId, role: "admin" });
    const forbidden = await clients(member, owner.orgId);
    for (const client of [forbidden.native, forbidden.remote]) await expect(client.getState()).rejects.toMatchObject({ statusCode: 404 });
    const readonly = await clients(owner, owner.orgId, { credential: { organizationId: owner.orgId, readOnly: true } });
    await expect(readonly.native.createPortal()).rejects.toMatchObject({ code: "TOKEN_READ_ONLY" });
    provider.enabled = false;
    const c = await clients(owner);
    for (const client of [c.native, c.remote]) {
      await expect(client.createSubscription({ planTierId: "starter", interval: "monthly", idempotencyKey: "parity-starter-checkout" })).rejects.toMatchObject({ code: "BILLING_NOT_ENABLED" });
      await expect(client.createTopup({ packId: CREDIT_PACKS[0]!.id })).rejects.toMatchObject({ code: "BILLING_NOT_ENABLED" });
      expect(await client.createPortal()).toHaveProperty("portalUrl");
      expect((await client.getState()).billing.enabled).toBe(false);
    }
    expect(provider.checkout).not.toHaveBeenCalled();
    expect(provider.checkout).not.toHaveBeenCalled();
  });

  it("isolates portal and renewal operations across tenants and exposes pending cancellation", async () => {
    const owner = await seedOwner(), other = await seedOwner(), c = await clients(owner), otherClients = await clients(other);
    await c.native.getState();
    await otherClients.native.getState();
    const namespace = (await billingWorkspace(owner)).namespace!;
    const otherNamespace = (await billingWorkspace(other)).namespace!;
    const subscription: NonNullable<OblienSubscription> = {
      tierId: "hobby", status: "active", billingInterval: "yearly", periodStart: "2026-09-01T00:00:00Z", periodEnd: "2027-09-01T00:00:00Z",
      cancelAtPeriodEnd: false, canceledAt: null,
    };
    provider.subscriptions.set(namespace, subscription);
    provider.subscriptions.set(otherNamespace, subscription);
    provider.enabled = false;
    for (const client of [c.native, c.remote]) {
      expect(await client.createPortal()).toEqual({ portalUrl: `https://billing.stripe.com/p/session/private-${namespace}` });
      expect(await client.cancelSubscription()).toMatchObject({ cancelAt: subscription.periodEnd, subscription: { tier: "starter", status: "active", interval: "annual", cancelAtPeriodEnd: true } });
      expect((await client.getSubscription()).subscription?.cancelAtPeriodEnd).toBe(true);
      const state = await client.getState();
      expect(state.status).toBe("active");
      expect(state.capabilities).toMatchObject({ portal: true, cancellation: true, resumption: true, subscriptionChange: false });
      expect(await client.resumeSubscription()).toMatchObject({ subscription: { cancelAtPeriodEnd: false } });
    }
    expect((await otherClients.native.getSubscription()).subscription?.cancelAtPeriodEnd).toBe(false);
    for (const [method, endpoint] of [[provider.portal, "portal"], [provider.cancel, "cancel"], [provider.resume, "resume"]] as const) {
      const response = await app.request(`/api/billing/${endpoint}`, {
        method: "POST", headers: { Authorization: `Bearer ${owner.token}`, "X-Organization-Id": owner.orgId, "Content-Type": "application/json" },
        body: JSON.stringify({ namespace: otherNamespace, customerId: "cus_foreign", subscriptionId: "sub_foreign" }),
      });
      expect(response.status).toBe(400);
      expect(method).toHaveBeenLastCalledWith(endpoint === "portal" ? expect.objectContaining({ namespace }) : namespace);
    }
    expect(provider.checkout).not.toHaveBeenCalled();
    await flushAudit();
    const events = await db.select().from(schema.auditEvent).where(eq(schema.auditEvent.organizationId, owner.orgId));
    expect(JSON.stringify(events)).not.toContain("private-");
    expect(JSON.stringify(events)).not.toContain("cus_foreign");
  });

  it("requires billing admin permission for both direct renewal actions and the hosted portal", async () => {
    const owner = await seedOwner(), member = await seedOwner({ bound: false });
    await db.insert(schema.member).values({ id: `billing-writer-${member.userId}`, organizationId: owner.orgId, userId: member.userId, role: "restricted" });
    await repos.resourceGrant.upsert({ organizationId: owner.orgId, userId: member.userId, resourceType: "billing", resourceId: "*", permissions: ["read", "write"], grantedByUserId: owner.userId });
    const c = await clients(member, owner.orgId);
    for (const client of [c.native, c.remote]) {
      await expect(client.createPortal()).rejects.toMatchObject({ statusCode: 404 });
      await expect(client.cancelSubscription()).rejects.toMatchObject({ statusCode: 404 });
      await expect(client.resumeSubscription()).rejects.toMatchObject({ statusCode: 404 });
    }
    expect(provider.portal).not.toHaveBeenCalled();
    expect(provider.cancel).not.toHaveBeenCalled();
    expect(provider.resume).not.toHaveBeenCalled();
  });

  it("uses Openship credit packs instead of legacy database prices and enforces the independent top-up switch", async () => {
    const owner = await seedOwner(), c = await clients(owner), pack = CREDIT_PACKS[0]!;
    await c.native.getState();
    provider.subscriptions.set((await billingWorkspace(owner)).namespace!, {
      tierId: "hobby", status: "active", billingInterval: "monthly", periodStart: "2026-09-01T00:00:00Z", periodEnd: "2026-10-01T00:00:00Z",
      cancelAtPeriodEnd: false, canceledAt: null,
    });
    await db.insert(schema.creditPack).values({ id: pack.id, name: pack.name, creditsMilli: 999, priceCents: 999, sortOrder: 0, stripeProductId: "product_retired", stripePriceId: "price_retired", active: true });
    const expectedPacks = [
      { id: "pack_400", credits_milli: 400_000, price_cents: 500 },
      { id: "pack_1700", credits_milli: 1_700_000, price_cents: 2000 },
      { id: "pack_4500", credits_milli: 4_500_000, price_cents: 5000 },
    ];
    for (const client of [c.native, c.remote]) {
      const packs = await client.listTopupPacks();
      expect(packs).toMatchObject(expectedPacks);
      for (const expectedPack of expectedPacks) {
        expect(await client.createTopup({ packId: expectedPack.id })).toEqual({
          checkoutUrl: "https://checkout.stripe.com/private-session",
        });
        expect(provider.checkout).toHaveBeenLastCalledWith(expect.objectContaining({
          namespace: (await billingWorkspace(owner)).namespace,
          kind: "topup",
          offer: {
            reference: `openship:${expectedPack.id}:v3`,
            name: "Openship compute credits",
            description: expect.any(String),
            unitAmount: expectedPack.price_cents,
            currency: "usd",
            credits: expectedPack.credits_milli / 1000,
          },
        }));
      }
    }
    expect(provider.checkout).toHaveBeenCalledTimes(6);
    provider.topups = false;
    for (const client of [c.native, c.remote])
      await expect(client.createTopup({ packId: pack.id })).rejects.toMatchObject({
        code: "BILLING_TOPUPS_NOT_ENABLED",
      });
    expect(provider.checkout).toHaveBeenCalledTimes(6);
  });

  it.each(["pack_500", "pack_5k"])("rejects the retired %s pack without creating a provider checkout", async packId => {
    const owner = await seedOwner(), c = await clients(owner);
    await c.native.getState();
    const namespace = (await billingWorkspace(owner)).namespace!;
    provider.subscriptions.set(namespace, {
      tierId: "hobby", status: "active", billingInterval: "monthly",
      periodStart: "2026-09-01T00:00:00Z", periodEnd: "2026-10-01T00:00:00Z",
      cancelAtPeriodEnd: false, canceledAt: null,
    });
    for (const client of [c.native, c.remote])
      await expect(client.createTopup({ packId })).rejects.toMatchObject({
        statusCode: 404, code: "BILLING_PACK_NOT_FOUND",
      });
    expect(provider.checkout).not.toHaveBeenCalled();
  });

  it.each(["canceled", "past_due"] as const)("refuses top-ups when entitlement is %s despite an active subscription row", async status => {
    const owner = await seedOwner(), c = await clients(owner);
    await c.native.getState();
    const namespace = (await billingWorkspace(owner)).namespace!;
    const subscription: NonNullable<OblienSubscription> = {
      tierId: "hobby", status: "active", billingInterval: "monthly",
      periodStart: "2025-08-01T00:00:00Z", periodEnd: "2025-09-01T00:00:00Z",
      cancelAtPeriodEnd: false, canceledAt: null,
    };
    provider.subscriptions.set(namespace, subscription);
    provider.entitlement.mockResolvedValue({
      success: true, namespace, tierId: subscription.tierId, status,
      periodStart: subscription.periodStart, periodEnd: subscription.periodEnd,
      quota: { limit: 1200, used: 0, balance: 1200 },
    });
    for (const client of [c.native, c.remote]) {
      expect((await client.getState()).topups).toEqual({ available: false, status: "unavailable" });
      await expect(client.createTopup({ packId: CREDIT_PACKS[0]!.id })).rejects.toMatchObject({
        statusCode: 402, code: "CLOUD_PLAN_REQUIRED",
      });
    }
    expect(provider.checkout).not.toHaveBeenCalled();
  });

  it.each(["active", "credit_exhausted"] as const)("permits top-ups for a paid %s entitlement without changing resource policy", async status => {
    const owner = await seedOwner(), c = await clients(owner);
    await c.native.getState();
    const namespace = (await billingWorkspace(owner)).namespace!;
    const subscription: NonNullable<OblienSubscription> = {
      tierId: "hobby", status: "active", billingInterval: "monthly",
      periodStart: "2026-09-01T00:00:00Z", periodEnd: "2026-10-01T00:00:00Z",
      cancelAtPeriodEnd: true, canceledAt: null,
    };
    provider.subscriptions.set(namespace, subscription);
    provider.entitlement.mockResolvedValue({
      success: true, namespace, tierId: subscription.tierId, status,
      periodStart: subscription.periodStart, periodEnd: subscription.periodEnd,
      quota: { limit: 1200, used: status === "credit_exhausted" ? 1200 : 0, balance: status === "credit_exhausted" ? 0 : 1200 },
    });
    for (const client of [c.native, c.remote]) {
      expect((await client.getState()).topups.available).toBe(true);
      expect(await client.createTopup({ packId: CREDIT_PACKS[0]!.id })).toHaveProperty("checkoutUrl");
    }
    expect(provider.resourceUpdate).not.toHaveBeenCalled();
  });

  it("bounds usage ranges and hides projects a billing-only reader cannot access", async () => {
    const owner = await seedOwner(), member = await seedOwner({ bound: false });
    // A not-yet-connected billing scope has no provider usage to fetch.
    await db.update(schema.cloudWorkspace).set({ namespace: null }).where(eq(schema.cloudWorkspace.id, (await billingWorkspace(owner)).id));
    const input = { organizationId: owner.orgId, name: "Private project", slug: `billing-${owner.userId.replaceAll("_", "-")}` };
    const group = await repos.projectGroup.create(input);
    const project = await repos.project.create({ ...input, groupId: group.id });
    await repos.domain.create({ projectId: project.id, hostname: `${input.slug}${FREE_DOMAIN_SUFFIX}` });
    await db.insert(schema.member).values({ id: `billing-reader-${member.userId}`, organizationId: owner.orgId, userId: member.userId, role: "restricted" });
    await repos.resourceGrant.upsert({ organizationId: owner.orgId, userId: member.userId, resourceType: "billing", resourceId: "*", permissions: ["read"], grantedByUserId: owner.userId });
    const c = await clients(member, owner.orgId);
    for (const client of [c.native, c.remote]) {
      expect((await client.listAllowanceDetail()).freeSubdomains.items).toEqual([]);
      expect(await client.getUsage({ from: "2026-01-01", to: "2026-01-02", groupBy: "day" })).toEqual({ from: "2026-01-01T00:00:00.000Z", to: "2026-01-02T00:00:00.000Z", groupBy: "day", usage: null });
      await expect(client.getUsage({ from: "2026-02-01", to: "2026-01-01" })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
      await expect(client.getUsage({ from: "2000-01-01", to: "2026-01-01" })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    }
    expect((await (await clients(owner)).native.listAllowanceDetail()).freeSubdomains.items.map(item => item.projectId)).toEqual([project.id]);
  });

  it("does not forward a fixed local tenant through an unverified owner cloud link", async () => {
    provider.cloudMode = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ data: presentCloudPlans() })),
    );
    const c = await clients(await seedOwner());
    for (const client of [c.native, c.remote]) {
      await expect(client.getState()).rejects.toMatchObject({ code: "CLOUD_NOT_CONNECTED" });
      await expect(client.createSubscription({ planTierId: "starter", interval: "monthly", idempotencyKey: "parity-starter-checkout" })).rejects.toMatchObject({ code: "CLOUD_NOT_CONNECTED" });
      expect((await client.listPlans()).plans.length).toBeGreaterThan(0);
    }
    expect(provider.cloudRequest).not.toHaveBeenCalled();
  });

});

describe("billing from a Cloud-connected self-hosted installation", () => {
  const localApp = new Hono().onError(handleApiError).route("/api/health", healthRoutes).route("/api/billing", billingLocalRoutes);
  const localFetcher = ((url, init) => localApp.request(String(url), init)) as typeof fetch;
  const quote: BillingPlanChangeQuote = {
    id: "quote_remote", direction: "upgrade", interval: "monthly", currency: "usd",
    expiresAt: "2030-01-01T00:00:00Z", effectiveAt: "2026-10-03T00:00:00Z",
    current: { name: "Hobby", priceCents: 500 }, next: { name: "Starter", priceCents: 2000 },
    amountDueNow: 636, unusedTimeCredit: 127, remainingTimeCharge: 763, nextInvoiceAmount: 2000,
    resize: null,
  };
  const change: BillingPlanChange = {
    id: "change_remote", direction: "upgrade", status: "payment_pending", currency: "usd",
    effectiveAt: quote.effectiveAt, current: quote.current, next: quote.next, amountDueNow: 636,
    cancelable: true, appliedAt: null, errorCode: null, paymentUrl: "https://invoice.stripe.com/i/test", paymentExpiresAt: null,
  };
  const pending: BillingPendingCheckout = {
    id: "a".repeat(64), checkoutId: "cs_pending", kind: "subscription", name: "Saved Pro offer", amountCents: 3900,
    currency: "usd", interval: "monthly", state: "open", canResume: true, canCancel: true,
    server: { id: "cloud-only-workspace", serverId: "cloud-only-server", name: "New managed server", planTierId: "free",
      subscriptionStatus: "active", state: "needs_plan", projectCount: 0, resources: null, operation: null, createdAt: "2026-10-06T00:00:00Z" },
  };
  function checkoutResponse(url: RequestInfo | URL, item = pending) {
    const path = new URL(String(url)).pathname;
    return Response.json({ data: path.endsWith("/checkouts") ? { items: [item] } : {
      status: path.endsWith("/cancel") ? "expired" : "ready", checkoutId: item.checkoutId,
      checkoutUrl: path.endsWith("/cancel") ? null : "https://checkout.stripe.com/pending-payment",
    } });
  }
  async function setup(options?: Parameters<typeof seedOwner>[0]) {
    const actor = await seedOwner(options);
    provider.cloudMode = false;
    const session = { apiUrl: cloudRuntimeTarget.api, userId: `cloud_${actor.userId}`,
      organizationId: `cloud_${actor.orgId}`, token: "synthetic-cloud-session" };
    await repos.settings.setCloudSession(actor.userId, encrypt(JSON.stringify(session)));
    const { token: _token, ...identity } = session;
    const linked = await repos.cloudWorkspace.link({ organizationId: actor.orgId, name: "Managed from self-hosted",
      remote: { ...identity, workspaceId: `remote_${actor.orgId}`, serverId: `remote_server_${actor.orgId}` } });
    const server = (await repos.server.findByWorkspace(linked.id, actor.orgId))!;
    const group = await repos.projectGroup.create({ organizationId: actor.orgId, name: "API", slug: `api-${actor.userId}` });
    const project = await repos.project.create({ organizationId: actor.orgId, groupId: group.id, serverId: server.id, name: "API", slug: group.slug });
    const external = vi.fn(async (url: RequestInfo | URL) => Response.json({
      data: String(url).endsWith("/preview") ? { ...quote, resize: {
        revision: "provider_revision", before: { cpuCores: 1, memoryMb: 4096, diskMb: 25600 },
        after: { cpuCores: 2, memoryMb: 8192, diskMb: 32768 }, restartProjects: [{ id: project.id, name: project.name }],
      } } : change,
    }));
    vi.stubGlobal("fetch", external);
    const pair = async (user = actor) => [
      (await clients(user, actor.orgId)).native,
      new OpenshipClient({ baseUrl: "http://local.test", token: user.token, organizationId: actor.orgId, fetch: localFetcher }).billing,
    ];
    return { actor, session, linked, server, project, external, pair };
  }

  it("reads plan changes from a sponsored server through HTTP and the SDK", async () => {
    const { linked, external, pair } = await setup();
    const sponsoredQuote = { ...quote, current: { ...quote.current, priceCents: 0 }, unusedTimeCredit: 0 };
    const sponsoredChange = { ...change, current: sponsoredQuote.current };
    external.mockImplementation(async url => Response.json({
      data: String(url).endsWith("/preview") ? sponsoredQuote : sponsoredChange,
    }));
    for (const client of await pair()) {
      expect(await client.previewSubscriptionChange({ workspaceId: linked.id, planTierId: "starter", idempotencyKey: "review-sponsored-server" }))
        .toMatchObject({ current: { priceCents: 0 }, next: { priceCents: 2000 }, unusedTimeCredit: 0 });
      expect(await client.getSubscriptionChange({ workspaceId: linked.id, changeId: change.id })).toEqual(sponsoredChange);
    }
    expect(provider.checkout).not.toHaveBeenCalled();
  });

  it("uses the stored Cloud identity and the same remote operations through HTTP and the SDK", async () => {
    const { actor, session, linked, project, external, pair } = await setup();
    for (const client of await pair()) {
      expect(await client.previewSubscriptionChange({ workspaceId: linked.id, planTierId: "starter", idempotencyKey: "review-linked-server-one" }))
        .toMatchObject({ id: quote.id, amountDueNow: 636, resize: { restartProjects: [{ id: project.id, name: "API" }] } });
      expect(await client.confirmSubscriptionChange({ workspaceId: linked.id, quoteId: quote.id, confirmRestart: true })).toEqual(change);
      expect(await client.getSubscriptionChange({ workspaceId: linked.id, changeId: change.id })).toEqual(change);
      expect(await client.cancelSubscriptionChange({ workspaceId: linked.id, changeId: change.id })).toEqual(change);
    }
    expect(external).toHaveBeenCalledTimes(8);
    for (const [index, call] of external.mock.calls.entries()) {
      const [url, init] = call as unknown as [string, RequestInit];
      const headers = new Headers(init.headers);
      expect(headers.get("Authorization")).toBe(`Bearer ${session.token}`);
      expect(headers.get("Authorization")).not.toContain(actor.token);
      expect(headers.get("X-Organization-Id")).toBe(session.organizationId);
      expect(String(url)).toContain(`${session.apiUrl}/api/billing/subscription/change`);
      if (index % 4 === 2) {
        expect(init.method).toBe("GET");
        expect(new URL(url).searchParams.get("workspaceId")).toBe(linked.remote!.workspaceId);
        expect(new URL(url).searchParams.get("changeId")).toBe(change.id);
      } else {
        expect(init.method).toBe("POST");
        const input = JSON.parse(String(init.body));
        expect(input.workspaceId).toBe(linked.remote!.workspaceId);
        expect(input.namespace).toBeUndefined();
        if (index % 4 === 1) expect(input).toEqual({ workspaceId: linked.remote!.workspaceId, quoteId: quote.id, confirmRestart: true });
      }
    }
    expect((await repos.cloudWorkspace.findById(linked.id))?.subscriptionChange).toBeNull();
    expect(provider.checkout).not.toHaveBeenCalled();
    expect(provider.resourceUpdate).not.toHaveBeenCalled();
  });

  it("requires local server and project write permission before forwarding restart consent", async () => {
    const { actor, linked, server, project, external, pair } = await setup();
    const member = await seedBaseOwner({ bound: false });
    await db.insert(schema.member).values({ id: `plan-manager-${member.userId}`, organizationId: actor.orgId, userId: member.userId, role: "restricted" });
    const grant = (resourceType: "billing" | "server" | "project", resourceId: string) => repos.resourceGrant.upsert({
      organizationId: actor.orgId, userId: member.userId, resourceType, resourceId, permissions: ["admin"], grantedByUserId: actor.userId,
    });
    await grant("billing", "*");
    const reviewers = await pair(member);
    const review = { workspaceId: linked.id, planTierId: "starter" as const, idempotencyKey: "review-linked-server-one" };
    const confirm = { workspaceId: linked.id, quoteId: quote.id, confirmRestart: true as const };
    for (const client of reviewers) await expect(client.previewSubscriptionChange(review)).rejects.toMatchObject({ statusCode: 404 });
    await grant("server", server.id);
    for (const client of reviewers) await expect(client.confirmSubscriptionChange(confirm)).rejects.toMatchObject({ statusCode: 404 });
    expect(external).not.toHaveBeenCalled();
    await grant("project", project.id);
    for (const client of reviewers) expect(await client.confirmSubscriptionChange(confirm)).toEqual(change);
    expect(external).toHaveBeenCalledTimes(2);
  });

  it("opens canonical Cloud billing without replicating a server or subscription", async () => {
    const { actor, external } = await setup({ bound: false });
    const before = await repos.cloudWorkspace.listByOrganization(actor.orgId);
    const response = await localApp.request("/api/billing/subscription/change/preview", {
      method: "POST", headers: { ...actor.auth, "X-Organization-Id": actor.orgId, "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId: "cloud-only-workspace", planTierId: "starter", idempotencyKey: "review-cloud-only-server" }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ data: { id: quote.id } });
    expect(external).toHaveBeenCalledOnce();
    expect(JSON.parse(String((external.mock.calls[0] as unknown as [string, RequestInit])[1].body)).workspaceId).toBe("cloud-only-workspace");
    expect(await repos.cloudWorkspace.listByOrganization(actor.orgId)).toEqual(before);
  });

  it("recovers discovered Cloud server payments through dashboard HTTP routes without creating a local execution link", async () => {
    const { actor, session, external } = await setup({ bound: false });
    external.mockImplementation(async url => checkoutResponse(url));
    const before = await repos.cloudWorkspace.listByOrganization(actor.orgId);
    const request = async (path: string, input?: unknown) => {
      const response = await localApp.request(`/api/billing/${path}`, {
        method: input ? "POST" : "GET",
        headers: { ...actor.auth, "X-Organization-Id": actor.orgId, "Content-Type": "application/json" },
        body: input ? JSON.stringify(input) : undefined,
      });
      expect(response.status).toBe(200);
      return (await response.json()).data;
    };
    expect(await request("checkouts")).toEqual({ items: [pending] });
    expect(await request(`checkouts?workspaceId=${pending.server.id}`)).toEqual({ items: [pending] });
    const input = { workspaceId: pending.server.id, id: pending.id };
    expect(await request("checkout/resume", input)).toMatchObject({ status: "ready", checkoutId: pending.checkoutId });
    expect(await request("checkout/cancel", input)).toMatchObject({ status: "expired", checkoutUrl: null });
    const requests = external.mock.calls as unknown as [string, RequestInit][];
    expect(requests).toHaveLength(4);
    expect(new URL(requests[0]![0]).searchParams.has("workspaceId")).toBe(false);
    expect(new URL(requests[1]![0]).searchParams.get("workspaceId")).toBe(pending.server.id);
    for (const [url, init] of requests) {
      expect(String(url)).toContain(`${session.apiUrl}/api/billing/checkout`);
      expect(new Headers(init.headers).get("Authorization")).toBe(`Bearer ${session.token}`);
      expect(new Headers(init.headers).get("X-Organization-Id")).toBe(session.organizationId);
      if (init.method === "POST") expect(JSON.parse(String(init.body))).toEqual(input);
    }
    expect(await repos.cloudWorkspace.listByOrganization(actor.orgId)).toEqual(before);
    expect(provider.checkout).not.toHaveBeenCalled();
  });

  it("uses local aliases consistently for checkout recovery through HTTP and the native SDK", async () => {
    const { linked, server, external, pair } = await setup();
    const item = { ...pending, server: { ...pending.server, id: linked.remote!.workspaceId, serverId: linked.remote!.serverId } };
    external.mockImplementation(async url => checkoutResponse(url, item));
    for (const client of await pair()) {
      expect(await client.listCheckouts({ workspaceId: linked.id })).toEqual({
        items: [{ ...item, server: { ...item.server, id: linked.id, serverId: server.id } }],
      });
      const input = { workspaceId: linked.id, id: item.id };
      expect(await client.resumeCheckout(input)).toMatchObject({ status: "ready" });
      expect(await client.cancelCheckout(input)).toMatchObject({ status: "expired" });
    }
    const requests = external.mock.calls as unknown as [string, RequestInit][];
    expect(requests).toHaveLength(6);
    for (const [url, init] of requests) {
      if (init.method === "GET") expect(new URL(url).searchParams.get("workspaceId")).toBe(linked.remote!.workspaceId);
      else expect(JSON.parse(String(init.body))).toEqual({ workspaceId: linked.remote!.workspaceId, id: item.id });
    }
    expect(provider.checkout).not.toHaveBeenCalled();
  });

  it("does not widen scoped HTTP or native checkout access to the owner's Cloud account", async () => {
    const { linked, external, pair } = await setup();
    for (const client of await pair()) {
      await expect(client.listCheckouts()).rejects.toMatchObject({ code: "CLOUD_SCOPE_UNAVAILABLE" });
      await expect(client.listCheckouts({ workspaceId: linked.remote!.workspaceId }))
        .rejects.toMatchObject({ code: "CLOUD_SCOPE_UNAVAILABLE" });
      const input = { workspaceId: linked.remote!.workspaceId, id: pending.id };
      await expect(client.resumeCheckout(input)).rejects.toMatchObject({ code: "CLOUD_SCOPE_UNAVAILABLE" });
      await expect(client.cancelCheckout(input)).rejects.toMatchObject({ code: "CLOUD_SCOPE_UNAVAILABLE" });
    }
    expect(external).not.toHaveBeenCalled();
  });

  it("rechecks local project access before confirming a canonical Cloud plan change", async () => {
    const { actor, linked, external } = await setup({ bound: false });
    const list = repos.project.listByWorkspace.bind(repos.project);
    vi.spyOn(repos.project, "listByWorkspace").mockImplementationOnce(async (...args) => {
      const projects = await list(...args);
      // Access can be revoked while reviewing a shared server's affected apps.
      await db.delete(schema.member).where(eq(schema.member.userId, actor.userId));
      return projects;
    });
    const response = await localApp.request("/api/billing/subscription/change", {
      method: "POST", headers: { ...actor.auth, "X-Organization-Id": actor.orgId, "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId: linked.remote!.workspaceId, quoteId: quote.id, confirmRestart: true }),
    });
    expect(response.status).toBe(404);
    expect(external).not.toHaveBeenCalled();
  });

  it("requires locally scoped callers to use their explicit server link", async () => {
    const { linked, external, pair } = await setup();
    for (const client of await pair()) {
      await expect(client.confirmSubscriptionChange({ workspaceId: linked.remote!.workspaceId, quoteId: quote.id, confirmRestart: true }))
        .rejects.toMatchObject({ code: "CLOUD_SCOPE_UNAVAILABLE" });
    }
    expect(external).not.toHaveBeenCalled();
  });

  it("does not turn a restricted billing grant into access to the owner's Cloud account", async () => {
    const { actor, linked, external } = await setup();
    const member = await seedBaseOwner({ bound: false });
    await db.update(schema.organization).set({ isTeam: true }).where(eq(schema.organization.id, actor.orgId));
    await db.insert(schema.member).values({ id: `billing-reader-${member.userId}`, organizationId: actor.orgId, userId: member.userId, role: "restricted" });
    await repos.resourceGrant.upsert({ organizationId: actor.orgId, userId: member.userId, resourceType: "billing", resourceId: "*", permissions: ["admin"], grantedByUserId: actor.userId });
    const response = await localApp.request("/api/billing/subscription/change", {
      method: "POST", headers: { ...member.auth, "X-Organization-Id": actor.orgId, "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId: linked.remote!.workspaceId, quoteId: quote.id, confirmRestart: true }),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "CLOUD_SCOPE_UNAVAILABLE" });
    expect(external).not.toHaveBeenCalled();
  });

  it("rejects a changed Cloud connection or another tenant's link before making a billing request", async () => {
    const { actor, session, linked, external, pair } = await setup();
    const foreign = await seedBaseOwner();
    const foreignLink = await repos.cloudWorkspace.link({ organizationId: foreign.orgId, name: "Other owner", remote: {
      ...linked.remote!, userId: "another-cloud-user", serverId: "another-server", workspaceId: "another-workspace",
    } });
    for (const client of await pair()) {
      await expect(client.getSubscriptionChange({ workspaceId: foreignLink.id, changeId: change.id })).rejects.toMatchObject({ statusCode: 404 });
    }
    await repos.settings.setCloudSession(actor.userId, encrypt(JSON.stringify({ ...session, organizationId: "replacement-cloud-org" })));
    for (const client of await pair()) {
      await expect(client.confirmSubscriptionChange({ workspaceId: linked.id, quoteId: quote.id, confirmRestart: true }))
        .rejects.toMatchObject({ code: "CLOUD_SERVER_CONNECTION_CHANGED" });
    }
    expect(external).not.toHaveBeenCalled();
  });
});
