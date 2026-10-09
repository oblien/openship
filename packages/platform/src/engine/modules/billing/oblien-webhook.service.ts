/**
 * Verify signed provider events, deduplicate stable delivery IDs, and refresh
 * the organization from Oblien's current entitlement. Events never grant credits
 * or suspend workspaces locally. Failed synchronization returns 503; provider
 * delivery retries durably; entitlement polling also refreshes the current state.
 * Actions events queue a receipt check in their separate prepaid ledger, without
 * changing the organization's application-server entitlement.
 */
import { diagnostics as errorDiagnostics } from "@repo/core/diagnostics";
export interface BillingWebhookResponse { status: number; payload: Record<string, unknown> }
import { db, schema, repos, eq, type Database } from "@repo/db";
import { createAuditEventRepo, createAuditSettingsRepo } from "@repo/db/repos";
import { safeErrorMessage } from "@repo/core";

import { env, localDashboardUrl } from "@repo/platform/engine/config/env";
import { notification } from "@repo/platform/engine/lib/notification-dispatcher";
import * as quotaWrapper from "@repo/platform/engine/modules/billing/billing-oblien-quota";
import {
  verifyOblienSignature,
  deriveOblienEventId,
  extractNamespace,
} from "@repo/platform/engine/modules/billing/oblien-webhook-crypto";

import { OBLIEN_WEBHOOK_EVENTS } from "../../lib/oblien-webhook-config";
import { observeVerifiedBillingEvent } from "../cloud-analytics/billing";
import { creditAlertNotification } from "./billing-credit-alert";
import { findBillingOwnerByNamespace } from "./billing-namespace-owner";

const ROUTED_EVENT_TYPES = new Set<string>(OBLIEN_WEBHOOK_EVENTS);

/* ───────── Payload shapes ───────────────────────────────────────────────── */

interface OblienUsageBucket {
  cpu_time_minutes?: number;
  memory_gb_minutes?: number;
  disk_io_gb?: number;
  network_gb?: number;
}

interface OblienWebhookData {
  namespace?: string;
  workspace_id?: string;
  workspace_name?: string;
  service?: string;
  /** credits.usage */
  balance?: number;
  credits_used?: number;
  period_start?: string;
  period_end?: string;
  usage?: OblienUsageBucket;
  /** credits.low / namespace.quota.threshold */
  used_percent?: number;
  threshold_percent?: number;
  percent?: number;
  threshold?: number;
  used?: number;
  limit?: number;
  [key: string]: unknown;
}

interface OblienWebhookPayload {
  id?: string;
  event?: string;
  timestamp?: string | number;
  namespace?: string;
  data?: OblienWebhookData;
  [key: string]: unknown;
}

function extractEventType(payload: OblienWebhookPayload): string | null {
  return typeof payload.event === "string" ? payload.event : null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function parseDate(v: unknown): Date | null {
  if (typeof v !== "string" && typeof v !== "number") return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Refresh the org's usage snapshot. Credit fields are converted Oblien-credit
 * → milli (the openship internal unit) via the quota wrapper's single boundary
 * so the dashboard's balance surface stays in one unit. Per-resource fields
 * are raw physical units.
 */
async function handleCreditsUsage(
  orgId: string,
  payload: OblienWebhookPayload,
  currentBalance: number | null,
): Promise<void> {
  const d = payload.data ?? {};
  const u = d.usage ?? {};
  const balance = currentBalance;
  const creditsUsed = num(d.credits_used);
  await repos.billingUsageSnapshot.upsert({
    organizationId: orgId,
    balance: balance != null ? quotaWrapper.fromOblienCredits(balance) : null,
    creditsUsed: creditsUsed != null ? quotaWrapper.fromOblienCredits(creditsUsed) : null,
    cpuTimeMinutes: num(u.cpu_time_minutes),
    memoryGbMinutes: num(u.memory_gb_minutes),
    diskIoGb: num(u.disk_io_gb),
    networkGb: num(u.network_gb),
    periodStart: parseDate(d.period_start),
    periodEnd: parseDate(d.period_end),
  });
}

/* ───────── Persistence helpers ──────────────────────────────────────────── */

async function upsertWebhookEventProcessed(
  tx: Database,
  eventId: string,
  eventType: string,
): Promise<void> {
  await tx
    .insert(schema.oblienWebhookEvent)
    .values({
      oblienEventId: eventId,
      eventType,
      processedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: schema.oblienWebhookEvent.oblienEventId,
      set: { processedAt: new Date() },
    });
}

/* ───────── Public Hono handler ──────────────────────────────────────────── */

/**
 * Hono handler for POST /api/billing/oblien-webhook.
 *
 * Mounted via `r.public(...)` so the user-auth middleware is bypassed —
 * authentication here is the HMAC signature, not a session token. Always
 * reads the raw body first (signature input), then parses the JSON itself;
 * never call `c.req.json()` before verification.
 */
export async function handleOblienWebhook(
  rawBody: string, signatureHeader?: string, deliveryId?: string,
): Promise<BillingWebhookResponse> {
  const sig = verifyOblienSignature(rawBody, signatureHeader, env.OBLIEN_WEBHOOK_SECRET);
  if (!sig.ok) return {
    status: sig.reason === "no_secret" ? 503 : 401,
    payload: { error: sig.reason === "no_secret" ? "Oblien webhook not configured" : "invalid signature" },
  };
  let payload: OblienWebhookPayload;
  try { payload = JSON.parse(rawBody); }
  catch { return { status: 400, payload: { error: "invalid json" } }; }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return { status: 400, payload: { error: "invalid json" } };
  const eventType = extractEventType(payload);
  if (!eventType) return { status: 400, payload: { error: "missing event" } };
  if (deliveryId && deliveryId.length > 256) return { status: 400, payload: { error: "invalid webhook id" } };
  // The body id is signed; a caller cannot change the unsigned header to replay
  // a current event under a new identity. Older usage events can lack a body id.
  if (payload.id !== undefined && (typeof payload.id !== "string" || !payload.id || payload.id.length > 256 || payload.id !== deliveryId)) {
    return { status: 400, payload: { error: "invalid webhook id" } };
  }
  const eventId = deriveOblienEventId(payload, deliveryId);
  const namespace = extractNamespace(payload);
  if (!ROUTED_EVENT_TYPES.has(eventType)) {
    await upsertWebhookEventProcessed(db, eventId, eventType);
    return { status: 200, payload: { received: true } };
  }
  if (!namespace) return { status: 400, payload: { error: "missing namespace" } };
  let orgId: string | undefined;
  try {
    const owner = await findBillingOwnerByNamespace(namespace);
    if (!owner) return { status: 200, payload: { received: true } };
    const organizationId = orgId = owner.organizationId;
    if (owner.kind === "actions") {
      // Actions funding is independent of a customer's monthly server. Only
      // enqueue a fresh receipt check; event amounts never grant retail funds.
      if (["payment.succeeded", "entitlement.changed"].includes(eventType) &&
        (payload.data?.kind == null || payload.data.kind === "topup")) {
        const { queueActionsPaymentCheck } = await import("../actions/billing-application");
        const metadata = payload.data?.metadata;
        const purchaseId = metadata && typeof metadata === "object" && !Array.isArray(metadata)
          ? (metadata as Record<string, unknown>).orderId : undefined;
        await queueActionsPaymentCheck(organizationId, {
          eventId, eventType,
          checkoutId: typeof payload.data?.checkoutId === "string" ? payload.data.checkoutId : undefined,
          purchaseId: typeof purchaseId === "string" ? purchaseId : undefined,
        });
      } else {
        await upsertWebhookEventProcessed(db, eventId, eventType);
      }
      return { status: 200, payload: { received: true } };
    }
    await quotaWrapper.withCloudBillingLock(organizationId, async (sync) => {
      const [existing] = await db.select({ processedAt: schema.oblienWebhookEvent.processedAt })
        .from(schema.oblienWebhookEvent)
        .where(eq(schema.oblienWebhookEvent.oblienEventId, eventId)).limit(1);
      if (existing?.processedAt) {
        await observeVerifiedBillingEvent(organizationId, eventType, payload.data, payload.timestamp);
        return;
      }
      // Every relevant notification refreshes provider truth. In particular,
      // old payment/suspension events cannot revert a newer paid entitlement.
      const { entitlement, tier } = await sync({ syncResourceLimits: false });
      if (entitlement.namespace !== namespace) throw new Error("Billing namespace changed during delivery");
      // This historical display cache belongs to the old organization namespace.
      // Workspace billing reads its own provider usage; never overwrite siblings.
      if (eventType === "credits.usage" && !owner.workspaceId) await handleCreditsUsage(organizationId, payload, entitlement.quota.balance);
      const alert = creditAlertNotification({ eventType, eventId, data: payload.data ?? {},
        timestamp: payload.timestamp, organizationId, workspaceId: owner.workspaceId ?? undefined, entitlement, dashboardUrl: localDashboardUrl });
      await observeVerifiedBillingEvent(organizationId, eventType, payload.data, payload.timestamp);
      const enqueue = alert ? await notification.prepare(alert) : null;
      // No email is sent while holding this transaction. The receiver only ACKs
      // once notifications, the exhaustion activity, and its checkpoint commit together.
      await db.transaction(async transaction => {
        const tx = transaction as unknown as Database;
        if (enqueue) await enqueue(tx);
        if (alert?.eventType === "billing.credit_exhausted") {
          await createAuditEventRepo(tx, createAuditSettingsRepo(tx)).create({
            organizationId,
            actorUserId: null,
            eventType: alert.eventType,
            resourceType: "organization",
            resourceId: organizationId,
            source: "webhook",
            after: { planTierId: tier, oblienNamespace: namespace, sourceEventId: eventId },
          });
        }
        await upsertWebhookEventProcessed(tx, eventId, eventType);
      });
    }, owner.workspaceId);
    if (owner.workspaceId) {
      const { reconcileWorkspaceSubscriptionChange } = await import("./billing-plan-change");
      await reconcileWorkspaceSubscriptionChange(organizationId, owner.workspaceId);
      const { requestPaidWorkspaceProvisioning } = await import("../cloud-workspaces/cloud-workspace.service");
      await requestPaidWorkspaceProvisioning(organizationId, owner.workspaceId);
    }
  } catch (error) {
    errorDiagnostics.warn("platform/engine/modules/billing/oblien-webhook.service", `[oblien-webhook] synchronization failed for ${orgId ? `org ${orgId}` : `namespace ${namespace}`}: ${safeErrorMessage(error)}`, error);
    return { status: 503, payload: { error: "Billing synchronization temporarily unavailable" } };
  }
  return { status: 200, payload: { received: true } };
}
