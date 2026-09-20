/** Display telemetry is independent of checkout, entitlements and provisioning. */
import { z } from "zod";
import { Oblien } from "@repo/adapters";
import { AppError, type PlanTierId } from "@repo/core";
import type { BillingResources } from "@repo/contracts";
import { repos } from "@repo/db";
import { env } from "../../config/env";
import { getOblienClient } from "../../lib/oblien-client";
import { buildMinutePeriod } from "../../lib/plan-guard";
import { CLOUD_EDGE_BANDWIDTH_GB } from "./billing-catalog";

const amount = z.number().finite().nonnegative();
const computeSchema = z.object({ success: z.literal(true), data: z.object({
  namespace: z.string(),
  totals: z.object({ vcpu_hours: amount, gb_hours: amount, disk_io_gb: amount, network_gb: amount }),
}) });
const domainsSchema = z.object({ success: z.literal(true), data: z.object({
  domains: z.array(z.object({ domain: z.string().min(1).max(253) })).max(1000),
}) });
const seriesSchema = z.object({ success: z.literal(true), data: z.array(z.object({
  timestamp: amount, requests: amount.int(), bandwidth_in: amount, bandwidth_out: amount,
})), meta: z.object({ from: amount, to: amount }) });
const cache = new Map<string, { until: number; value: Promise<BillingResources> }>();

/** Bound the whole read, including discovery, without modifying the shared client. */
function timedClient(options: ConstructorParameters<typeof Oblien>[0], signal: AbortSignal) {
  const client = new Oblien(options);
  // The SDK owns endpoint formatting; its default transport has no redirect
  // control. Never forward owner credentials or a scoped token to another host.
  const base = (options.baseUrl ?? "https://api.oblien.com").replace(/\/+$/, "");
  const headers = { "Content-Type": "application/json", ...("token" in options
    ? { Authorization: `Bearer ${options.token}` }
    : { "X-Client-ID": options.clientId, "X-Client-Secret": options.clientSecret }) };
  client._http.request = async <T>({ path, method, query, body }: Parameters<Oblien["_http"]["request"]>[0]): Promise<T> => {
    const url = new URL(`${base}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) if (value !== undefined) url.searchParams.set(key, String(value));
    const response = await fetch(url.toString(), {
      method, headers, signal, redirect: "error", ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw new Error("Cloud metrics unavailable");
    return response.json() as Promise<T>;
  };
  return client;
}

async function readEdge(namespace: string, from: Date, to: Date, signal: AbortSignal) {
  // A namespace token prevents domain discovery or a reassigned hostname from
  // ever returning another customer's traffic. It stays entirely on our server.
  getOblienClient(); // Enforce the SaaS-only credential boundary.
  const owner = timedClient({ clientId: env.OBLIEN_CLIENT_ID!, clientSecret: env.OBLIEN_CLIENT_SECRET!, baseUrl: env.OBLIEN_API_URL }, signal);
  const token = await owner.tokens.create({ scope: "namespace", namespace, ttl: 60 });
  if (!token.success || token.scope !== "namespace" || !token.token) throw new Error("Invalid scoped analytics token");
  const client = timedClient({ token: token.token, baseUrl: env.OBLIEN_API_URL }, signal);
  const home = domainsSchema.parse(await client.analytics.home({ namespace }));
  const domains = [...new Set(home.data.domains.map(row => row.domain))];
  const totals = { requests: 0, bandwidthGb: 0, inboundGb: 0, outboundGb: 0 };
  // Home totals have no documented time window. Sum explicit period queries;
  // never show lifetime traffic as a monthly allowance or credit records as requests.
  for (let index = 0; index < domains.length; index += 6) {
    const rows = await Promise.all(domains.slice(index, index + 6).map(async domain => {
      const result = seriesSchema.parse(await client.analytics.timeseries(domain, {
        from: from.getTime(), to: to.getTime(), interval: "hour",
      }));
      if (result.meta.from !== from.getTime() || result.meta.to !== to.getTime()) throw new Error("Analytics range mismatch");
      return result.data;
    }));
    for (const buckets of rows) for (const bucket of buckets) {
      totals.requests += bucket.requests;
      totals.inboundGb += bucket.bandwidth_in / 1_000_000_000;
      totals.outboundGb += bucket.bandwidth_out / 1_000_000_000;
    }
  }
  totals.bandwidthGb = totals.inboundGb + totals.outboundGb;
  return totals;
}

export async function getBillingResources(organizationId: string): Promise<BillingResources> {
  const org = await repos.organization.findById(organizationId);
  if (!org) throw new AppError("Organization not found", 404, "ORGANIZATION_NOT_FOUND");
  const now = new Date();
  const tier = (org.planTierId ?? "free") as PlanTierId;
  const monthly = buildMinutePeriod(org.currentPeriodStart ?? org.createdAt, now);
  const start = org.currentPeriodStart && org.currentPeriodStart <= now ? org.currentPeriodStart : monthly.from;
  const end = org.currentPeriodEnd && org.currentPeriodEnd > start ? org.currentPeriodEnd : monthly.to;
  const period = { start: start.toISOString(), end: end.toISOString() };
  const edgePeriod = { start: monthly.from.toISOString(), end: monthly.to.toISOString() };
  const empty: BillingResources = {
    measuredAt: now.toISOString(),
    compute: { status: "unavailable", period, cpuHours: null, memoryGbHours: null, diskIoGb: null, networkGb: null },
    edge: { status: "unavailable", period: edgePeriod, limits: { bandwidthGb: CLOUD_EDGE_BANDWIDTH_GB[tier] }, requests: null, bandwidthGb: null, inboundGb: null, outboundGb: null },
  };
  // No namespace is not evidence of metered zero usage. This endpoint never
  // creates resources or updates their policies merely to display a dashboard.
  if (!org.oblienNamespace) return empty;
  const namespace = org.oblienNamespace;
  const key = JSON.stringify([organizationId, namespace, tier, period, edgePeriod]);
  const existing = cache.get(key);
  if (existing && existing.until > now.getTime()) return structuredClone(await existing.value);
  const value = (async () => {
    const signal = AbortSignal.timeout(12_000);
    const computeTo = new Date(Math.min(now.getTime(), end.getTime()));
    const edgeTo = new Date(Math.min(now.getTime(), monthly.to.getTime()));
    const [compute, edge] = await Promise.allSettled([
      (async () => {
        getOblienClient();
        const client = timedClient({ clientId: env.OBLIEN_CLIENT_ID!, clientSecret: env.OBLIEN_CLIENT_SECRET!, baseUrl: env.OBLIEN_API_URL }, signal);
        const result = computeSchema.parse(await client.namespaces.usageUnits(namespace, { from: start.toISOString(), to: computeTo.toISOString(), groupBy: "day" }));
        if (result.data.namespace !== namespace) throw new Error("Usage namespace mismatch");
        const totals = result.data.totals;
        return { cpuHours: totals.vcpu_hours, memoryGbHours: totals.gb_hours, diskIoGb: totals.disk_io_gb, networkGb: totals.network_gb };
      })(),
      readEdge(namespace, monthly.from, edgeTo, signal),
    ]);
    if (compute.status === "fulfilled") empty.compute = { ...empty.compute, status: "available", ...compute.value };
    if (edge.status === "fulfilled") empty.edge = { ...empty.edge, status: "available", ...edge.value };
    for (const [name, result] of [["compute", compute], ["edge", edge]] as const) {
      // Provider errors may contain tokens or customer data. Log no raw payload.
      if (result.status === "rejected") console.warn(`[billing:resources] ${name} metrics unavailable`, { organizationId });
    }
    return empty;
  })();
  // Bounded, short-lived cache. It never supplies authorization or credit grants.
  if (cache.size >= 256) cache.delete(cache.keys().next().value!);
  cache.set(key, { until: now.getTime() + 30_000, value });
  const result = await value;
  if (result.compute.status !== "available" || result.edge.status !== "available") cache.delete(key);
  return structuredClone(result);
}

export function __resetBillingResourcesForTests() { cache.clear(); }
