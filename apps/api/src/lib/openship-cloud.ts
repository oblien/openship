/**
 * Openship Cloud - namespace provisioning + token minting.
 *
 * Runs on the SaaS API (CLOUD_MODE=true) only. Local instances
 * call POST /api/cloud/token to get a namespace-scoped token,
 * then use `new Oblien({ token })` to drive the full pipeline
 * themselves (workspaces.create, build, deploy - everything).
 *
 * **Namespace identity = organization id**, NOT user id. This makes
 * the namespace atomic per team: owner rotation doesn't move the
 * namespace, every team member resolves the same one, and there's
 * no `resolveCloudOwner` indirection in the SaaS controllers.
 *
 * Two responsibilities:
 *   1. ensureNamespace(orgId) - create-if-not-exists, cached
 *   2. issueNamespaceToken(orgId) - mint a scoped token for the namespace
 */

import { Oblien } from "@repo/adapters";
import { repos } from "@repo/db";
import { env } from "../config/env";
import { DEFAULT_PLAN_TIER, safeErrorMessage, type PlanTierId } from "@repo/core";
import { cacheStore } from "./cache-store";
import { getOblienClient } from "./oblien-client";
import { setQuotaForTier } from "../modules/billing/billing-oblien-quota";

// ─── Oblien client ──────────────────────────────────────────────────────────

/**
 * Re-exported from the leaf `oblien-client` module, which is where it now lives.
 * Keeping the name importable from here means the five consumers that only ever
 * wanted a client did not have to move — while `billing-oblien-quota`, the one
 * module that was on the other side of the cycle, imports the leaf DIRECTLY. That
 * asymmetry is the whole point: if it came back through this file, the cycle would
 * re-form and the static import below would be the thing that breaks.
 */
export { getOblienClient } from "./oblien-client";

// ─── Webhook registration ────────────────────────────────────────────────────

/**
 * The billing events our receiver (`/api/billing/oblien-webhook`) handles.
 * Account-wide (no `namespace` scope) so one webhook covers every org's
 * namespace — Oblien caps accounts at 10 webhooks, so we keep exactly one.
 */
const OBLIEN_WEBHOOK_EVENTS = [
  "credits.usage",
  "credits.low",
  "credits.depleted",
  "namespace.quota.threshold",
  // DELIBERATELY NOT `namespace.suspended` / `namespace.restored`. Oblien's billing
  // docs list them, but the SDK's `WebhookEvent` union at 2.2.45 stops at
  // `namespace.quota.threshold` — they belong to the newer billing plane this
  // client can't speak. Subscribing would at best be a no-op and at worst make
  // `webhooks.update` reject the whole event set, taking the credits events down
  // with it. Suspension is detected by polling instead
  // (`reconcileOblienEntitlement`), which is what Oblien's own docs recommend
  // anyway: "delivery is best-effort … reconcile via the entitlement endpoint."
  // Add them here the moment the SDK's union does.
] as const;

/**
 * Ensure our billing webhook is registered with Oblien. Idempotent: if a
 * webhook already targets our URL we refresh its events + secret + active flag
 * (self-heals a rotated secret or an event-set change); otherwise we create it.
 * No-op + warn when the secret or public URL isn't configured — without both
 * the receiver can't verify deliveries or even be reached. CLOUD_MODE only.
 */
export async function ensureOblienWebhook(): Promise<void> {
  if (!env.CLOUD_MODE) return;

  const secret = env.OBLIEN_WEBHOOK_SECRET;
  const base = env.OPENSHIP_PUBLIC_URL?.trim();
  if (!secret) {
    console.warn(
      "[oblien] OBLIEN_WEBHOOK_SECRET unset — skipping webhook registration (deliveries would be unverifiable)",
    );
    return;
  }
  if (!base) {
    console.warn(
      "[oblien] OPENSHIP_PUBLIC_URL unset — skipping webhook registration (no public URL for Oblien to reach)",
    );
    return;
  }

  const url = `${base.replace(/\/+$/, "")}/api/billing/oblien-webhook`;
  const events = [...OBLIEN_WEBHOOK_EVENTS];

  try {
    const client = getOblienClient();
    const { webhooks } = await client.webhooks.list();
    const existing = webhooks.find((w) => w.url === url);

    if (existing) {
      await client.webhooks.update(existing.id, { events, secret, active: true });
      console.log(`[oblien] webhook ${existing.id} refreshed → ${url}`);
      return;
    }

    const created = await client.webhooks.create({
      url,
      events,
      secret,
      description: "Openship billing (credits + quota)",
    });
    console.log(`[oblien] webhook ${created.webhook?.id ?? "?"} registered → ${url}`);
  } catch (err) {
    // Non-fatal at boot — the receiver still works once a webhook exists;
    // log loudly so operators notice a persistent failure.
    console.error(`[oblien] webhook registration failed: ${safeErrorMessage(err)}`);
  }
}

// ─── Namespace management ────────────────────────────────────────────────────

// Org ↔ namespace is effectively immutable — 1h TTL is generous and
// self-heals on miss anyway via Oblien's idempotent `namespaces.ensure`.
const NAMESPACE_CACHE_TTL_S = 60 * 60;

/**
 * Org id → namespace slug. For solo users (orgId = `org_<userId>`)
 * this strips the prefix → `os-<userId>` — keeping pre-multi-tenant
 * namespaces stable. Team orgs get `os-<orgId>` directly.
 */
function namespaceSlugForOrg(orgId: string): string {
  const stripped = orgId.startsWith("org_") ? orgId.slice(4) : orgId;
  return `os-${stripped.toLowerCase().replace(/[^a-z0-9-]+/g, "-")}`;
}

/**
 * Ensure an Oblien namespace exists for an org, and PERSIST the slug.
 *
 * Resolution order is DB → cache → Oblien, and the write order is DB before
 * cache. Both directions matter:
 *
 *   - Reading the DB first means the namespace survives a cache eviction and a
 *     restart. It previously lived in `cacheStore` ONLY, so `organization
 *     .oblien_namespace` stayed NULL forever — and every consumer of that column
 *     opens with `if (!org.oblienNamespace) return`. The whole entitlement path
 *     (setQuota, resource_limits, credit top-ups, the `credits.usage` webhook
 *     match) was therefore a silent no-op.
 *   - Writing the DB BEFORE the cache means a failed DB write retries on the next
 *     call instead of being masked by a cache hit for the TTL.
 *
 * Idempotent via Oblien's own `namespaces.ensure`, so adopting a namespace that
 * already exists is the normal path, not an error.
 */
export async function ensureNamespace(organizationId: string): Promise<string> {
  const existing = await repos.organization
    .findById(organizationId)
    .catch(() => null);
  if (existing?.oblienNamespace) return existing.oblienNamespace;

  const store = await cacheStore<string>("oblien-namespaces");
  const cached = await store.get(organizationId);
  if (cached) {
    // Cache hit with no DB row: a previous run persisted only to the cache.
    // Heal the row rather than leaving the column NULL.
    await repos.organization
      .setOblienNamespace(organizationId, cached)
      .catch(() => {});
    return cached;
  }

  const client = getOblienClient();
  const slug = namespaceSlugForOrg(organizationId);

  const ensured = await client.namespaces.ensure({
    name: `Openship ${organizationId}`,
    slug,
  });

  const namespace = ensured.data.slug || slug;
  await repos.organization.setOblienNamespace(organizationId, namespace);
  await store.set(organizationId, namespace, NAMESPACE_CACHE_TTL_S);
  return namespace;
}

/**
 * Cache namespace recording that an org's Oblien ceiling has been asserted.
 *
 * This is a `cacheStore`, not a module-level `Set`, and the difference is not
 * cosmetic:
 *
 *   - MULTI-REPLICA. The SaaS runs several API replicas. A per-process Set means
 *     each replica asserts separately, so the memo did roughly nothing for the
 *     N-1 replicas that had not seen the org yet. Backed by Redis this is shared,
 *     which is correct: the ceiling lives on Oblien, so if ANY replica pushed it,
 *     it is pushed.
 *   - BOUNDED. A Set accumulates one entry per org for the life of the process and
 *     is never swept — a slow leak that grows with the tenant count. `cacheStore`
 *     evicts (`maxSize`) and expires.
 *   - SELF-HEALING. A permanent memo means a ceiling that drifted (a failed
 *     upgrade webhook, a manual edit on Oblien) is only repaired by the hourly
 *     reconciler. With a TTL the spend path re-asserts on its own.
 *
 * It also matches how `ensureNamespace` above already memoizes the namespace slug,
 * so there is one idiom in this file rather than two.
 */
const QUOTA_ASSERTED_NS = "oblien-quota-asserted";

/**
 * How long an assertion is trusted.
 *
 * Deliberately the reconciler's cadence (hourly). Shorter would push redundant
 * writes onto the analytics fan-out — `collectCloud` issues one namespace token
 * PER DOMAIN, in parallel, so a 10-domain project would otherwise pay 20 Oblien
 * writes to open a geo panel. Longer would leave the spend path trusting a
 * ceiling nothing has re-checked since before the last drift sweep.
 */
const QUOTA_ASSERTED_TTL_S = 3600;

async function quotaAssertedStore() {
  return cacheStore<number>(QUOTA_ASSERTED_NS, { maxSize: 10_000 });
}

/**
 * Namespace for RUNNING A WORKLOAD — guarantees the ceiling exists before the
 * caller can spend anything. Use this, never bare `ensureNamespace`, anywhere a
 * namespace is about to become compute.
 *
 * THE HOLE THIS CLOSES. `ensureNamespace` returns early the moment
 * `organization.oblien_namespace` is set, and nothing in it touches quota. Org
 * creation does pair the two (`provisionOrgNamespace`), but that call is
 * fire-and-forget in `auth.ts` — deliberately, so a slow Oblien can't fail
 * signup. So when it failed, the first deploy called bare `ensureNamespace`,
 * which CREATED and RECORDED the namespace with no quota at all. From then on
 * every later call hit the early return, the boot backfill skipped the org
 * (it has a namespace, so it looks done), and the org ran fully metered with no
 * credit ceiling and no resource ceiling. Free, unlimited compute, indefinitely.
 *
 * FAILS CLOSED, and that is the point: if the ceiling cannot be asserted we do
 * not hand back a namespace to spend against. `setQuotaForTier` throws on an
 * Oblien error and this deliberately does not catch it — a deploy that fails
 * loudly is recoverable, an uncapped tenant is not. (Enterprise is the one tier
 * with `monthlyCredits === null`; `setQuotaForTier` returns early for it, which
 * is the negotiated-contract case, not a bypass.)
 *
 * `setQuotaForTier` is a STATIC import. It used to be a dynamic one, purely to
 * dodge a cycle (`billing-oblien-quota` reached back here for the client) — that
 * cycle is gone now the client lives in the `oblien-client` leaf, so the dependency
 * is declared honestly at the top of the file where a reader can see it.
 */
export async function ensureNamespaceWithQuota(organizationId: string): Promise<string> {
  const namespace = await ensureNamespace(organizationId);

  const store = await quotaAssertedStore();
  if (await store.get(organizationId)) return namespace;

  const org = await repos.organization.findById(organizationId).catch(() => null);
  await setQuotaForTier(organizationId, (org?.planTierId as PlanTierId) ?? DEFAULT_PLAN_TIER);

  // Recorded only after the push actually succeeded — a throw above must leave the
  // org unmarked so the next attempt retries instead of trusting a failed write.
  await store.set(organizationId, Date.now(), QUOTA_ASSERTED_TTL_S);
  return namespace;
}

/** Test seam: forget every recorded assertion. */
export async function __resetQuotaAssertedForTests(): Promise<void> {
  const store = await quotaAssertedStore();
  await store.invalidateByPrefix("");
}

// ─── Token minting ───────────────────────────────────────────────────────────

export interface NamespaceTokenResult {
  token: string;
  namespace: string;
  expiresAt: string;
}

export interface NamespaceClientResult {
  /** Oblien SDK instance bound to a namespace-scoped token for this org. */
  client: Oblien;
  /**
   * Namespace slug for this org. Pass this on every Oblien create-shape
   * call that accepts a `namespace` field (pages.create, edgeProxy.create,
   * edgeTunnel.create, workspace.create, tokens.create) so Oblien can
   * cross-check that the resource belongs to the token's namespace.
   * Non-create methods identify the resource by id/slug — namespace
   * isn't an input param, the token scope is the only gate.
   */
  namespace: string;
}

/**
 * Issue a namespace-scoped Oblien token for an org. The token gives
 * full access to the org's namespace — create workspaces, manage
 * lifecycle, deploy, analytics, edge proxies, pages. Local instances
 * construct `new Oblien({ token })` and run the full pipeline.
 *
 * TTL: 30 minutes (covers build + deploy + some buffer).
 */
export async function issueNamespaceToken(organizationId: string): Promise<NamespaceTokenResult> {
  const client = getOblienClient();
  // `ensureNamespaceWithQuota`, NOT bare `ensureNamespace`. This token is full
  // namespace authority — create workspaces, deploy, run — so the ceiling has to
  // be on Oblien before it leaves this function.
  const namespace = await ensureNamespaceWithQuota(organizationId);

  try {
    const result = await client.tokens.create({
      scope: "namespace",
      namespace,
      ttl: 1800,
    });

    return {
      token: result.token,
      namespace,
      expiresAt: result.expiresAt,
    };
  } catch (err: unknown) {
    console.error("Oblien SDK token issuance error", err);
    const message = safeErrorMessage(err);
    throw new Error(`Failed to issue Oblien namespace token for ${namespace}: ${message}`);
  }
}

/**
 * Canonical "I need to call Oblien for this org" entry point.
 *
 * Returns BOTH the namespace-scoped client AND the namespace slug, so
 * callers can pass `namespace` explicitly on Oblien's create-shape
 * methods. Oblien validates that the resource being created lives in
 * the namespace the token authenticates — without the explicit param
 * the create methods accept any namespace the token is allowed in
 * (today that's exactly one — but defense in depth).
 *
 * Non-create methods (disable / enable / delete / list / update by id
 * or slug, analytics by domain) don't accept namespace as input — the
 * token scope is the only gate there. Oblien rejects cross-namespace
 * mutations with 403/404 server-side post-fix.
 *
 * Replaces the duplicated ad-hoc `getNamespaceClient` helpers that
 * lived inside each cloud-* service file (those discarded the
 * namespace slug, defeating the explicit pass-through).
 */
export async function getNamespaceClient(
  organizationId: string,
): Promise<NamespaceClientResult> {
  const { token, namespace } = await issueNamespaceToken(organizationId);
  return { client: new Oblien({ token }), namespace };
}
