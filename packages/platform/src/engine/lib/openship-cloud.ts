/**
 * Each subscribed workspace owns an immutable Oblien namespace. Existing dedicated
 * projects retain their organization namespace. All customer workspace
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
import { cloudBillingOwner, ensureDefaultCloudWorkspace, type CloudWorkspaceScope } from "./cloud-workspace-scope";

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

/** Every subscribed server owns one immutable provider namespace. */
export async function ensureNamespace(organizationId: string, workspaceId?: CloudWorkspaceScope): Promise<string> {
  let owner = await cloudBillingOwner(organizationId, workspaceId);
  if (!owner.workspace) {
    const initial = await ensureDefaultCloudWorkspace(organizationId);
    owner = await cloudBillingOwner(organizationId, initial.id);
  }
  const selected = owner.workspace!.id;
  return createProvisionLock(`cloud:namespace:workspace:${selected}`).run(async () => {
    const existing = await cloudBillingOwner(organizationId, selected);
    if (!existing.workspace || existing.workspace.deletionInProgress)
      throw new AppError("Managed server is unavailable", 409, "CLOUD_WORKSPACE_DELETING");
    if (existing.namespace) return existing.namespace;
    await ensureOblienDefaultQuota();
    const slug = `os-w-${createHash("sha256").update(selected).digest("hex").slice(0, 40)}`;
    const ensured = await getOblienClient().namespaces.ensure({
      name: `Openship ${existing.workspace.name}`, slug,
      resource_limits: await initialCloudNamespaceLimits(),
    });
    if (ensured.data.slug !== slug) throw new AppError("Cloud returned an unexpected namespace", 502, "CLOUD_NAMESPACE_MISMATCH");
    await repos.cloudWorkspace.setNamespace(selected, organizationId, slug);
    return slug;
  });
}

// This memo contains a successful READ, never a quota grant. Spend operations
// also check fresh entitlement and balance immediately before provisioning.
async function quotaAssertedStore() {
  return cacheStore<number>("oblien-policy-verified", { maxSize: 10_000 });
}

export async function ensureNamespaceWithQuota(organizationId: string, workspaceId?: CloudWorkspaceScope): Promise<string> {
  const namespace = await ensureNamespace(organizationId, workspaceId);
  const owner = await cloudBillingOwner(organizationId, workspaceId);
  const store = await quotaAssertedStore();
  if (!await store.get(namespace)) {
    await assertNamespaceHasQuota(organizationId, owner.workspaceId);
    await store.set(namespace, Date.now(), 60);
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
  providerApiUrl: string;
}

export interface NamespaceClientResult {
  client: Oblien;
  namespace: string;
}

export async function issueNamespaceToken(organizationId: string, workspaceId?: CloudWorkspaceScope): Promise<NamespaceTokenResult> {
  if (!env.CLOUD_MODE) {
    if (!workspaceId) throw new AppError("Choose a managed server before requesting execution access", 409, "DEPLOYMENT_SERVER_REQUIRED");
    const { remoteServerConnection } = await import("./cloud/server-connection");
    const connection = await remoteServerConnection(organizationId, workspaceId);
    return { token: connection.token, namespace: connection.namespace, expiresAt: connection.expiresAt, providerApiUrl: connection.providerApiUrl };
  }
  const namespace = await ensureNamespaceWithQuota(organizationId, workspaceId);
  try {
    const result = await getOblienClient().tokens.create({ scope: "namespace", namespace, ttl: 1800 });
    return { token: result.token, namespace, expiresAt: result.expiresAt, providerApiUrl: env.OBLIEN_API_URL };
  } catch (error) {
    console.warn(`[oblien] token issuance failed for org ${organizationId}: ${safeErrorMessage(error)}`);
    throw new AppError("Cloud access is temporarily unavailable. Please retry.", 503, "CLOUD_TOKEN_UNAVAILABLE");
  }
}

export async function getNamespaceClient(organizationId: string, workspaceId?: CloudWorkspaceScope): Promise<NamespaceClientResult> {
  const { token, namespace, providerApiUrl } = await issueNamespaceToken(organizationId, workspaceId);
  return { client: new Oblien({ token, baseUrl: providerApiUrl }), namespace };
}
