/**
 * Oblien webhook receiver — POST /api/billing/oblien-webhook.
 *
 * Single entry point for events Oblien fires against our endpoint
 * (registered once at boot via `ensureOblienWebhook`, account-wide).
 * Four event types matter:
 *
 *   - `credits.usage`             → refresh the org's usage snapshot
 *                                   (balance / credits_used / per-resource
 *                                   metered units) so the dashboard renders
 *                                   without a live Oblien round-trip.
 *   - `credits.depleted`          → suspend the namespace + flip the org to
 *                                   `credit_exhausted`, and emit the audit +
 *                                   notification for the transition.
 *   - `credits.low`               → soft warning email (approaching the cap).
 *   - `namespace.quota.threshold` → distinct threshold email carrying the
 *                                   crossed percent / used / limit.
 *
 * Anything else is accepted (2xx) but treated as a no-op — Oblien does not
 * retry, so we simply record it as seen.
 *
 * Signature verification: HMAC-SHA256 hex of the RAW request body using
 * OBLIEN_WEBHOOK_SECRET, delivered in the `X-Webhook-Signature` header
 * (Oblien signs the body only — no timestamp, no `sha256=` prefix, though we
 * tolerate the prefix defensively). Compared in constant time. Missing header
 * OR mismatch → 401. Missing secret (env not configured) → 503: a
 * security-critical endpoint must never silently accept unverified traffic.
 * The handler MUST read the raw body before parsing JSON — we need the exact
 * bytes Oblien signed.
 *
 * Idempotency: Oblien's envelope carries NO event id, so we derive a stable
 * one from `event : (workspace_id|namespace) : timestamp` and dedupe on the
 * `oblien_webhook_event` table + Postgres advisory-lock (same shape as
 * billing.webhooks.ts). Including the per-delivery `timestamp` means genuine
 * periodic `credits.usage` refreshes are each distinct (not collapsed), while
 * an exact re-delivery still dedupes.
 *
 * Runs only under CLOUD_MODE — Oblien webhooks target the SaaS.
 */

import type { Context } from "hono";
import { db, schema, repos, eq, sql, hashStringToInt } from "@repo/db";
import { safeErrorMessage } from "@repo/core";

import { env } from "../../config/env";
import { sendMail } from "../../lib/mail";
import { audit } from "../../lib/audit";
import { notification } from "../../lib/notification-dispatcher";
import * as quotaWrapper from "./billing-oblien-quota";
import {
  verifyOblienSignature,
  deriveOblienEventId,
  extractNamespace,
} from "./oblien-webhook-crypto";

/* ───────── Constants ────────────────────────────────────────────────────── */

const HEADER_SIGNATURE = "x-webhook-signature";

/** Set of event types the dispatcher has handlers for. */
const ROUTED_EVENT_TYPES = new Set<string>([
  "credits.usage",
  "credits.depleted",
  "credits.low",
  "namespace.quota.threshold",
]);

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

function readAcquired(result: unknown): boolean {
  if (typeof result !== "object" || result === null) return false;
  const rows = (result as { rows?: unknown }).rows;
  if (Array.isArray(rows) && rows.length > 0) {
    const first = rows[0] as { acquired?: boolean | null };
    return first.acquired === true;
  }
  return false;
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
    const { resolveOrgOwner } = await import("../../lib/org-actor");
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
    const { resolveOrgOwner } = await import("../../lib/org-actor");
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
    { organizationId: orgId, actorUserId: null },
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
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
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
export async function oblienWebhook(c: Context) {
  const signatureHeader = c.req.header(HEADER_SIGNATURE);
  const rawBody = await c.req.text();

  const sig = verifyOblienSignature(rawBody, signatureHeader, env.OBLIEN_WEBHOOK_SECRET);
  if (!sig.ok) {
    if (sig.reason === "no_secret") {
      console.error(
        "[oblien-webhook] OBLIEN_WEBHOOK_SECRET is not configured — refusing delivery",
      );
      return c.json({ error: "Oblien webhook not configured" }, 503);
    }
    console.warn(`[oblien-webhook] signature rejected: ${sig.reason}`);
    return c.json({ error: "invalid signature" }, 401);
  }

  let payload: OblienWebhookPayload;
  try {
    payload = JSON.parse(rawBody) as OblienWebhookPayload;
  } catch {
    return c.json({ error: "invalid json" }, 400);
  }

  const eventType = extractEventType(payload);
  if (!eventType) {
    return c.json({ error: "missing event" }, 400);
  }

  const eventId = deriveOblienEventId(payload);
  const namespace = extractNamespace(payload);
  const lockKey = hashStringToInt(`oblien:event:${eventId}`);

  await db.transaction(async (tx) => {
    const lockResult = await tx.execute(
      sql`SELECT pg_try_advisory_xact_lock(${lockKey}) AS acquired`,
    );
    if (!readAcquired(lockResult)) {
      // Peer is processing this event — their commit stamps processed_at.
      return;
    }

    const [existing] = await tx
      .select({ processedAt: schema.oblienWebhookEvent.processedAt })
      .from(schema.oblienWebhookEvent)
      .where(eq(schema.oblienWebhookEvent.oblienEventId, eventId))
      .limit(1);
    if (existing?.processedAt) return;

    if (!ROUTED_EVENT_TYPES.has(eventType)) {
      console.warn(
        `[oblien-webhook] received unrouted event ${eventType} (id=${eventId}) — accepting without action`,
      );
      await upsertWebhookEventProcessed(tx, eventId, eventType);
      return;
    }

    if (!namespace) {
      console.warn(
        `[oblien-webhook] event ${eventId} (${eventType}) has no namespace — accepting without action`,
      );
      await upsertWebhookEventProcessed(tx, eventId, eventType);
      return;
    }

    const orgId = await findOrgByNamespace(namespace);
    if (!orgId) {
      console.warn(
        `[oblien-webhook] event ${eventId} (${eventType}) namespace=${namespace} has no matching org`,
      );
      await upsertWebhookEventProcessed(tx, eventId, eventType);
      return;
    }

    try {
      switch (eventType) {
        case "credits.usage":
          await handleCreditsUsage(orgId, payload);
          break;
        case "credits.depleted":
          await handleCreditsDepleted(orgId);
          break;
        case "credits.low":
          await handleCreditsLow(orgId, payload);
          break;
        case "namespace.quota.threshold":
          await notifyQuotaThreshold(orgId, payload.data ?? {});
          break;
      }
      await upsertWebhookEventProcessed(tx, eventId, eventType);
    } catch (err) {
      console.error(
        `[oblien-webhook] handler failed for ${eventType} (id=${eventId}, org=${orgId}): ${safeErrorMessage(err)}`,
      );
      throw err;
    }
  });

  return c.json({ received: true });
}
