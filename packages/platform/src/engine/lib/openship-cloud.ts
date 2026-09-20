/**
 * One organization owns one immutable Oblien namespace. All customer workspace
 * operations use short-lived namespace tokens, including operations on the SaaS.
 */
import { createHash } from "node:crypto";
import { Oblien } from "@repo/adapters";
import { AppError, safeErrorMessage } from "@repo/core";
import { repos } from "@repo/db";
import { env, runtimeTarget } from "../config/env";
import { cacheStore } from "./cache-store/index";
import { getOblienClient } from "./oblien-client";
import { createProvisionLock } from "./provision-lock";
import { initialCloudNamespaceLimits } from "./cloud-resource-limits";
import { assertNamespaceHasQuota, ensureOblienDefaultQuota } from "../modules/billing/billing-oblien-quota";
import { OBLIEN_WEBHOOK_EVENTS, oblienWebhookUrl } from "./oblien-webhook-config";

export { getOblienClient } from "./oblien-client";

export { OBLIEN_WEBHOOK_EVENTS } from "./oblien-webhook-config";

export async function ensureOblienWebhook(): Promise<void> {
  if (!env.CLOUD_MODE) return;
  const secret = env.OBLIEN_WEBHOOK_SECRET;
  if (!secret) {
    throw new AppError("Cloud billing requires OBLIEN_WEBHOOK_SECRET", 503, "OBLIEN_WEBHOOK_NOT_CONFIGURED");
  }
  const url = oblienWebhookUrl(env.OBLIEN_WEBHOOK_URL, runtimeTarget.api);
  const client = getOblienClient();
  // SDK 2.3 includes billing lifecycle events, including cancellation/resume.
  const events = [...OBLIEN_WEBHOOK_EVENTS];
  const { webhooks } = await client.webhooks.list();
  const existing = webhooks.find((webhook) => webhook.url === url);
  if (existing) {
    await client.webhooks.update(existing.id, { events, secret, active: true, namespace: null });
  } else {
    await client.webhooks.create({ url, events, secret, description: "Openship cloud billing and entitlements" });
  }
}

const NAMESPACE_CACHE_TTL_S = 3600;

/** Hash exact identity: case-folding and stripping prefixes can alias two orgs. */
export function namespaceSlugForOrg(orgId: string): string {
  return `os-${createHash("sha256").update(orgId).digest("hex").slice(0, 40)}`;
}

export async function ensureNamespace(organizationId: string): Promise<string> {
  return createProvisionLock(`cloud:namespace:${organizationId}`).run(async () => {
    const existing = await repos.organization.findById(organizationId);
    if (!existing) throw new AppError("Organization not found", 404, "ORGANIZATION_NOT_FOUND");
    if (existing.oblienNamespace) return existing.oblienNamespace;

    const store = await cacheStore<string>("oblien-namespaces");
    const cached = await store.get(organizationId);
    if (cached) {
      // Recover older persisted mappings, but never issue a token if recording
      // ownership fails. The database enforces one org per namespace.
      await repos.organization.setOblienNamespace(organizationId, cached);
      return cached;
    }

    await ensureOblienDefaultQuota();
    const slug = namespaceSlugForOrg(organizationId);
    const ensured = await getOblienClient().namespaces.ensure({
      name: `Openship ${organizationId}`, slug,
      resource_limits: await initialCloudNamespaceLimits(),
    });
    if (ensured.data.slug !== slug) {
      throw new AppError("Cloud returned an unexpected namespace", 502, "CLOUD_NAMESPACE_MISMATCH");
    }
    await repos.organization.setOblienNamespace(organizationId, slug);
    await store.set(organizationId, slug, NAMESPACE_CACHE_TTL_S);
    return slug;
  });
}

// This memo contains a successful READ, never a quota grant. Spend operations
// also check fresh entitlement and balance immediately before provisioning.
async function quotaAssertedStore() {
  return cacheStore<number>("oblien-policy-verified", { maxSize: 10_000 });
}

export async function ensureNamespaceWithQuota(organizationId: string): Promise<string> {
  const namespace = await ensureNamespace(organizationId);
  const store = await quotaAssertedStore();
  if (!await store.get(organizationId)) {
    await assertNamespaceHasQuota(organizationId);
    await store.set(organizationId, Date.now(), 60);
  }
  return namespace;
}

export async function __resetQuotaAssertedForTests(): Promise<void> {
  await (await quotaAssertedStore()).invalidateByPrefix("");
}

export interface NamespaceTokenResult {
  token: string;
  namespace: string;
  expiresAt: string;
}

export interface NamespaceClientResult {
  client: Oblien;
  namespace: string;
}

export async function issueNamespaceToken(organizationId: string): Promise<NamespaceTokenResult> {
  const namespace = await ensureNamespaceWithQuota(organizationId);
  try {
    const result = await getOblienClient().tokens.create({ scope: "namespace", namespace, ttl: 1800 });
    return { token: result.token, namespace, expiresAt: result.expiresAt };
  } catch (error) {
    console.warn(`[oblien] token issuance failed for org ${organizationId}: ${safeErrorMessage(error)}`);
    throw new AppError("Cloud access is temporarily unavailable. Please retry.", 503, "CLOUD_TOKEN_UNAVAILABLE");
  }
}

export async function getNamespaceClient(organizationId: string): Promise<NamespaceClientResult> {
  const { token, namespace } = await issueNamespaceToken(organizationId);
  return { client: new Oblien({ token, baseUrl: env.OBLIEN_API_URL }), namespace };
}
