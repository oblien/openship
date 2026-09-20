import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ org: vi.fn(), guard: vi.fn(), build: vi.fn() }));
vi.mock("@repo/db", () => ({ repos: { organization: { findById: h.org }, deployment: { sumBuildMillisForOrg: h.build } } }));
vi.mock("@repo/platform/engine/config/env", () => ({ env: {
  CLOUD_MODE: true, OBLIEN_CLIENT_ID: "test-owner", OBLIEN_CLIENT_SECRET: "test-secret", OBLIEN_API_URL: "https://provider.test",
} }));
vi.mock("@repo/platform/engine/lib/oblien-client", () => ({ getOblienClient: h.guard, getOblienBillingApi: vi.fn() }));
import { getBillingResources, __resetBillingResourcesForTests } from "@repo/platform/engine/modules/billing/billing-resources.service";
import { getBuildMinuteUsage } from "@repo/platform/engine/lib/plan-guard";

const org = { id: "org-a", oblienNamespace: "ns-a", planTierId: "starter", createdAt: new Date("2026-01-31"),
  currentPeriodStart: new Date("2026-09-01"), currentPeriodEnd: new Date("2026-10-01") };
let fetcher: ReturnType<typeof vi.fn<typeof fetch>>;
let edgeFailure = false, wrongNamespace = false;
beforeEach(() => {
  vi.resetAllMocks();
  __resetBillingResourcesForTests();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-19T10:00:00Z"));
  h.org.mockImplementation(async id => ({ ...org, id, oblienNamespace: id === "org-b" ? "ns-b" : "ns-a" }));
  h.build.mockResolvedValue(125 * 60_000);
  edgeFailure = wrongNamespace = false;
  vi.spyOn(console, "warn").mockImplementation(() => {});
  fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    if (url.pathname.endsWith("/usage-units")) {
      expect(headers.get("X-Client-ID")).toBe("test-owner");
      expect(url.searchParams.get("from")).toBe("2026-09-01T00:00:00.000Z");
      const namespace = url.pathname.split("/")[2];
      return Response.json({ success: true, data: { namespace: wrongNamespace ? "somebody-else" : namespace,
        totals: { vcpu_hours: namespace === "ns-b" ? 10 : 2, gb_hours: 4, disk_io_gb: .25, network_gb: 1.5 } } });
    }
    if (url.pathname === "/tokens") {
      const body = JSON.parse(String(init?.body));
      expect(body).toEqual({ scope: "namespace", namespace: expect.stringMatching(/^ns-[ab]$/), ttl: 60 });
      return Response.json({ success: true, scope: "namespace", token: `token-${body.namespace}`, ttl: 60 });
    }
    if (url.pathname === "/analytics/home/summary") {
      const namespace = url.searchParams.get("ns");
      expect(headers.get("Authorization")).toBe(`Bearer token-${namespace}`);
      expect(headers.has("X-Client-Secret")).toBe(false);
      if (edgeFailure) return Response.json({ success: false, error: "unavailable", private: "must not be logged" }, { status: 503 });
      return Response.json({ success: true, data: { domains: [{ domain: `${namespace}.example.com` }, { domain: `${namespace}.example.com` }], totals: { requests: 999999999 } } });
    }
    expect(url.pathname).toMatch(/^\/analytics\/ns-[ab]\.example\.com\/timeseries$/);
    const namespace = url.pathname.split("/")[2]!.split(".")[0];
    expect(headers.get("Authorization")).toBe(`Bearer token-${namespace}`);
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    return Response.json({ success: true, data: [
      { timestamp: Date.parse("2026-09-02") / 1000, requests: 100, bandwidth_in: 1_000_000_000, bandwidth_out: 2_000_000_000 },
      { timestamp: Date.parse("2026-09-03") / 1000, requests: 30, bandwidth_in: 0, bandwidth_out: 500_000_000 },
    ], meta: { from: Number(url.searchParams.get("from")), to: Number(url.searchParams.get("to")) } });
  });
  vi.stubGlobal("fetch", fetcher);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("Oblien 2.4 namespace resource usage", () => {
  it("shows measured units and period edge traffic, without confusing account totals or credit records with requests", async () => {
    const result = await getBillingResources("org-a");
    expect(result.compute).toMatchObject({ status: "available", cpuHours: 2, memoryGbHours: 4, diskIoGb: .25, networkGb: 1.5 });
    expect(result.edge).toMatchObject({ status: "available", requests: 130, bandwidthGb: 3.5, inboundGb: 1, outboundGb: 2.5, limits: { bandwidthGb: 50 } });
    expect(result.edge.period).toEqual({ start: "2026-09-01T00:00:00.000Z", end: "2026-10-01T00:00:00.000Z" });
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(JSON.stringify(result)).not.toMatch(/token-|test-secret|example\.com|999999999/);
  });
  it("deduplicates concurrent dashboard reads but never shares another customer's usage", async () => {
    const [a, again] = await Promise.all([getBillingResources("org-a"), getBillingResources("org-a")]);
    expect(a).toEqual(again);
    expect(fetcher).toHaveBeenCalledTimes(4);
    a.compute.cpuHours = 999;
    expect((await getBillingResources("org-a")).compute.cpuHours).toBe(2);
    expect((await getBillingResources("org-b")).compute.cpuHours).toBe(10);
    expect(fetcher).toHaveBeenCalledTimes(8);
  });
  it("keeps compute readable during an edge failure and reports unknown usage instead of zero", async () => {
    edgeFailure = true;
    const result = await getBillingResources("org-a");
    expect(result.compute.status).toBe("available");
    expect(result.edge).toMatchObject({ status: "unavailable", requests: null, bandwidthGb: null });
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toMatch(/token-|test-secret|must not be logged/);
  });
  it("rejects a provider usage response for a different namespace", async () => {
    wrongNamespace = true;
    const result = await getBillingResources("org-a");
    expect(result.compute).toMatchObject({ status: "unavailable", cpuHours: null });
    expect(result.edge.status).toBe("available");
  });
  it("does not provision or grant resources to obtain an empty dashboard", async () => {
    h.org.mockResolvedValue({ ...org, oblienNamespace: null, planTierId: "free" });
    const result = await getBillingResources("org-a");
    expect(result.edge.limits.bandwidthGb).toBe(0);
    expect(result.compute.cpuHours).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("still measures build usage on plans with no build-minute cap", async () => {
    h.org.mockResolvedValue({ ...org, planTierId: "enterprise" });
    const result = await getBuildMinuteUsage("org-a");
    expect(result).toMatchObject({ usedMinutes: 125, limitMinutes: null, remainingMinutes: null, exhausted: false });
    expect(h.build).toHaveBeenCalledOnce();
  });
});
