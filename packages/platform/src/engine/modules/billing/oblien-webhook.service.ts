/**
 * Verify signed provider events, deduplicate stable delivery IDs, and refresh
 * the organization from Oblien's current entitlement. Events never grant credits
 * or suspend workspaces locally. Failed synchronization returns 503; provider
 * delivery is best effort, so entitlement polling and the recurring sweep repair it.
 */
export interface BillingWebhookResponse { status: number; payload: Record<string, unknown> }
import { db, schema, repos, eq } from "@repo/db";
import { safeErrorMessage } from "@repo/core";

import { env } from "@repo/platform/engine/config/env";
import { sendMail } from "@repo/platform/engine/lib/mail";
import { audit } from "@repo/platform/engine/lib/audit-emitter";
import { notification } from "@repo/platform/engine/lib/notification-dispatcher";
import * as quotaWrapper from "@repo/platform/engine/modules/billing/billing-oblien-quota";
import {
  verifyOblienSignature,
  deriveOblienEventId,
  extractNamespace,
} from "@repo/platform/engine/modules/billing/oblien-webhook-crypto";

import { OBLIEN_WEBHOOK_EVENTS } from "../../lib/oblien-webhook-config";

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

/* ───────── Org resolution by namespace ──────────────────────────────────── */

async function findOrgByNamespace(namespace: string): Promise<string | null> {
  const [row] = await db
    .select({ id: schema.organization.id })
    .from(schema.organization)
    .where(eq(schema.organization.oblienNamespace, namespace))
    .limit(1);
  return row?.id ?? null;
}

/* ───────── Notification helpers ─────────────────────────────────────────── */

async function notifyCreditsLow(orgId: string, usedPercent: number | null): Promise<void> {
  try {
    const { resolveOrgOwner } = await import("@repo/platform/engine/lib/org-actor");
    const owner = await resolveOrgOwner(orgId, "first-member");
    if (!owner?.user?.email) return;

    const pct = usedPercent != null ? Math.round(usedPercent) : 80;
    await sendMail({
      to: owner.user.email,
      subject: `You've used ${pct}% of this period's credits`,
      html: `
        <p>Hi ${owner.user.name ?? "there"},</p>
        <p>Your workspace has used <strong>${pct}%</strong> of this period's credit allowance.</p>
        <p>To avoid interruption when the cap is reached, you can top up or upgrade your plan at any time from the billing page.</p>
        <p>— Openship</p>
      `,
      text: `Your workspace has used ${pct}% of this period's credit allowance. Top up or upgrade from the billing page to avoid interruption.`,
      organizationId: orgId,
    });
  } catch (err) {
    console.warn(
      `[oblien-webhook] notifyCreditsLow failed for org ${orgId}: ${safeErrorMessage(err)}`,
    );
  }
}

async function notifyQuotaThreshold(
  orgId: string,
  data: OblienWebhookData,
): Promise<void> {
  const pct = num(data.percent) ?? num(data.threshold) ?? null;
  try {
    const { resolveOrgOwner } = await import("@repo/platform/engine/lib/org-actor");
    const owner = await resolveOrgOwner(orgId, "first-member");
    if (owner?.user?.email) {
      const pctLabel = pct != null ? `${Math.round(pct)}%` : "a";
      const detail =
        num(data.used) != null && num(data.limit) != null
          ? `<p>Used <strong>${data.used}</strong> of <strong>${data.limit}</strong> credits.</p>`
          : "";
      await sendMail({
        to: owner.user.email,
        subject: `Credit usage crossed ${pctLabel} of your quota`,
        html: `
          <p>Hi ${owner.user.name ?? "there"},</p>
          <p>Your workspace has crossed the <strong>${pctLabel}</strong> usage threshold for this period.</p>
          ${detail}
          <p>Top up or upgrade from the billing page to avoid interruption when the cap is reached.</p>
          <p>— Openship</p>
        `,
        text: `Your workspace crossed the ${pctLabel} usage threshold this period. Top up or upgrade from the billing page to avoid interruption.`,
        organizationId: orgId,
      });
    }
  } catch (err) {
    console.warn(
      `[oblien-webhook] notifyQuotaThreshold failed for org ${orgId}: ${safeErrorMessage(err)}`,
    );
  }

  notification.emit({
    organizationId: orgId,
    eventType: "quota.threshold_fired",
    resourceType: "organization",
    resourceId: orgId,
    payload: {
      percent: pct,
      used: num(data.used),
      limit: num(data.limit),
      service: typeof data.service === "string" ? data.service : null,
    },
  });
}

/* ───────── Per-event handlers ───────────────────────────────────────────── */

/**
 * Refresh the org's usage snapshot. Credit fields are converted Oblien-credit
 * → milli (the openship internal unit) via the quota wrapper's single boundary
 * so the dashboard's balance surface stays in one unit. Per-resource fields
 * are raw physical units.
 */
async function handleCreditsUsage(
  orgId: string,
  payload: OblienWebhookPayload,
): Promise<void> {
  const d = payload.data ?? {};
  const u = d.usage ?? {};
  const balance = num(d.balance);
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

/**
 * Depletion is INFORMATIONAL on our side. Oblien has already stopped the
 * namespace's workspaces via `onOverdraftAction: "stop_workspaces"` — we do
 * NOT suspend/activate anything (that would just race Oblien). We only record
 * the event + tell the org so they can top up / upgrade. Access is restored
 * automatically by Oblien once a topup/renewal lifts the ceiling above usage.
 */
async function handleCreditsDepleted(orgId: string): Promise<void> {
  const org = await repos.organization.findById(orgId);
  if (!org) return;

  await audit.record(
    { organizationId: orgId, actorUserId: null, source: "webhook" },
    {
      eventType: "billing.credit_exhausted",
      resourceType: "organization",
      resourceId: orgId,
      after: {
        planTierId: org.planTierId,
        oblienNamespace: org.oblienNamespace ?? null,
      },
    },
  );
  notification.emit({
    organizationId: orgId,
    eventType: "billing.credit_exhausted",
    resourceType: "organization",
    resourceId: orgId,
    payload: {
      planTierId: org.planTierId,
      oblienNamespace: org.oblienNamespace ?? null,
    },
  });
}

async function handleCreditsLow(
  orgId: string,
  payload: OblienWebhookPayload,
): Promise<void> {
  const usedPercent =
    num(payload.data?.used_percent) ?? num(payload.data?.threshold_percent);
  await notifyCreditsLow(orgId, usedPercent);
}

/* ───────── Persistence helpers ──────────────────────────────────────────── */

async function upsertWebhookEventProcessed(
  tx: typeof db,
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
  const orgId = await findOrgByNamespace(namespace);
  if (!orgId) return { status: 200, payload: { received: true } };

  try {
    await quotaWrapper.withCloudBillingLock(orgId, async (sync) => {
      const [existing] = await db.select({ processedAt: schema.oblienWebhookEvent.processedAt })
        .from(schema.oblienWebhookEvent)
        .where(eq(schema.oblienWebhookEvent.oblienEventId, eventId)).limit(1);
      if (existing?.processedAt) return;
      // Every relevant notification refreshes provider truth. In particular,
      // old payment/suspension events cannot revert a newer paid entitlement.
      const { entitlement } = await sync();
      switch (eventType) {
        case "credits.usage":
          await handleCreditsUsage(orgId, payload);
          break;
        case "credits.depleted":
        case "namespace.suspended":
          if (entitlement.status === "credit_exhausted") await handleCreditsDepleted(orgId);
          break;
        case "credits.low":
          await handleCreditsLow(orgId, payload);
          break;
        case "namespace.quota.threshold":
          await notifyQuotaThreshold(orgId, payload.data ?? {});
          break;
      }
      // Stamp only after the mirror succeeds. A failed read remains retryable.
      await upsertWebhookEventProcessed(db, eventId, eventType);
    });
  } catch (error) {
    console.warn(`[oblien-webhook] synchronization failed for org ${orgId}: ${safeErrorMessage(error)}`);
    return { status: 503, payload: { error: "Billing synchronization temporarily unavailable" } };
  }
  return { status: 200, payload: { received: true } };
}
