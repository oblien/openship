import type { Context } from "hono";
import { z } from "zod";
import { AppError } from "@repo/core";
import { getRequestContext } from "../../lib/request-context";
import { ensureNamespace } from "@repo/platform/engine/lib/openship-cloud";
import { createTenantCloudAdmin } from "@repo/platform/engine/lib/cloud-tenant-admin";

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
const path = z.string().min(1).max(2048);
const domain = z.string().min(1).max(253);
const source = z.object({ workspace_id: id, path }).strict();
const action = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("proxy"), workspace: id, port: z.number().int().min(1).max(65535),
    stripPrefix: z.boolean().optional(), path: path.optional() }).strict(),
  z.object({ kind: z.literal("rewrite"), to: path }).strict(),
  z.object({ kind: z.literal("redirect"), to: path, status: z.union([z.literal(301), z.literal(302), z.literal(307), z.literal(308)]).optional() }).strict(),
  z.object({ kind: z.literal("headers"), set: z.array(z.object({ key: z.string().max(256), value: z.string().max(8192) }).strict()).max(64) }).strict(),
]);
export const cloudResourceInput = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("list") }).strict(),
  z.object({ operation: z.literal("create"), input: source.extend({ name: z.string().min(1).max(256), slug: id.optional(), domain: domain.optional() }).strict() }).strict(),
  z.object({ operation: z.literal("deploy"), slug: id, input: source }).strict(),
  z.object({ operation: z.enum(["get", "enable", "disable", "delete", "getDomain", "disconnectDomain", "renewSSL"]), slug: id }).strict(),
  z.object({ operation: z.literal("connectDomain"), slug: id, input: z.object({ domain, includeWww: z.boolean().optional() }).strict() }).strict(),
  z.object({ operation: z.literal("checkDNS"), slug: id, input: z.object({ domain }).strict() }).strict(),
  z.object({ operation: z.literal("setRoutes"), hostname: domain, input: z.object({
    routes: z.array(z.object({ match: z.object({ path, type: z.enum(["exact", "prefix", "wildcard"]).optional() }).strict(), action }).strict()).max(256),
    static: z.object({ page: id }).strict().optional(),
    cleanUrls: z.boolean().optional(), trailingSlash: z.enum(["enforce", "strip"]).optional(), spa: z.boolean().optional(),
  }).strict() }).strict(),
]);

async function tenant(c: Context) {
  const { organizationId } = getRequestContext(c);
  return createTenantCloudAdmin(organizationId, await ensureNamespace(organizationId));
}

/** Each operation validates ownership through the same SaaS tenant delegate. */
export async function cloudResourceProxy(c: Context) {
  const parsed = cloudResourceInput.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Invalid Cloud resource operation", code: "CLOUD_RESOURCE_INVALID" }, 400);
  return providerResponse(async () => {
    const proxy = await tenant(c);
    const body = parsed.data;
    const pages = proxy.pages!;
    switch (body.operation) {
      case "list": return c.json(await pages.list());
      case "create": return c.json(await pages.create(body.input));
      case "deploy": return c.json(await pages.deploy(body.slug, body.input));
      case "connectDomain": return c.json(await pages.connectDomain(body.slug, body.input));
      case "checkDNS": return c.json(await pages.checkDNS(body.slug, body.input));
      case "setRoutes": return c.json(await proxy.setRoutes!(body.hostname, body.input));
      default: return c.json(await pages[body.operation](body.slug));
    }
  });
}

export async function cloudRouteRegistry(c: Context) {
  return providerResponse(async () => c.json(await (await tenant(c)).domainRoutes!()));
}

async function providerResponse(operation: () => Promise<Response>): Promise<Response> {
  try { return await operation(); }
  catch (error) {
    if (error instanceof AppError) throw error;
    const status = (error as { status?: unknown } | null)?.status;
    throw new AppError(status === 404 ? "Cloud resource not found" : "Cloud could not complete this resource operation",
      typeof status === "number" && status >= 400 && status < 500 ? status : 502, "CLOUD_PROVIDER_ERROR");
  }
}
