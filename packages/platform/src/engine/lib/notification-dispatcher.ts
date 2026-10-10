/**
 * Notification dispatcher.
 *
 * The fan-out point from "an event happened" to "N notification_delivery
 * rows enqueued, each pointing at one user × one channel". The actual
 * sending is done by per-channel workers in lib/notification-workers/.
 *
 * Call site:
 *   notification.emit({
 *     organizationId,
 *     eventType: "deployment.failed",
 *     resourceType: "deployment",
 *     resourceId: dep.id,
 *     auditEventId: optionalRowFromAudit,
 *     payload: { branch, errorMessage, ... },
 *   });
 *
 * Behavior:
 *   1. Map eventType → category. Unknown types are dropped silently.
 *   2. Look up every enabled subscription for (org, category).
 *   3. For each subscription, resolve the channel row.
 *   4. Skip if channel disabled / unverified.
 *   5. Insert one notification_delivery row per (user, channel) in
 *      "queued" status. The worker loop picks them up.
 *
 * Fire-and-forget by default — dispatch errors are logged but never
 * thrown to the caller. The audit_event already captured the original
 * event; failed notifications shouldn't break the action that caused
 * them.
 */

import { reportCaughtError as observeCaughtError, diagnostics as errorDiagnostics } from "@repo/core/diagnostics";
import { repos, createNotificationDeliveryRepo, type Database, type NotificationDelivery } from "@repo/db";
import type { ChannelKind } from "@repo/db";
import { categoryForEventType, findCategory } from "./notification-categories";
import { fireJobTriggers } from "../modules/jobs/job-events";
import { trackBackgroundWork } from "./background-work";
import { canReceiveNotification } from "./notification-access";
import { observeCloudNotification } from "../modules/cloud-analytics/lifecycle";

export interface NotificationEmitInput {
  organizationId: string;
  /** Stable verified event identity for critical, transaction-bound delivery. */
  idempotencyKey?: string;
  /** The audit_event.event_type. Used for category mapping + the
   *  payload-snapshot subject line. */
  eventType: string;
  /** Optional id of the audit_event row that caused this. Lets the
   *  Settings UI cross-link a notification to its source event. */
  auditEventId?: string;
  resourceType?: string;
  resourceId?: string;
  /** Explicit, previously authorized channel references. Delivery still rechecks
   * channel ownership, membership and resource access. */
  destinations?: { channelIds: string[]; includeSubscriptions?: boolean };
  /** Free-form payload — channel workers render this with their own
   *  template (subject + body for email, JSON for webhook, etc.). */
  payload?: Record<string, unknown>;
}

type PendingDelivery = Omit<NotificationDelivery, "id" | "createdAt" | "nextAttemptAt" | "leaseUntil" | "sentAt" | "seenAt" | "lastError">;

async function dispatch(input: NotificationEmitInput, prepared?: PendingDelivery[]): Promise<void> {
  const category = categoryForEventType(input.eventType);
  if (!category) return;
  const strict = !!prepared;
  const source = repos;
  const read = <T>(promise: Promise<T>, fallback: T): Promise<T> => strict ? promise : promise.catch((diagnosticFailure) => { observeCaughtError(diagnosticFailure, "platform/engine/lib/notification-dispatcher"); return fallback; });
  const tolerate = async (work: () => Promise<void>) => {
    try { await work(); } catch (error) {
      if (strict) throw error;
      errorDiagnostics.error("platform/engine/lib/notification-dispatcher", `[notification] dispatch failed for category=${category}:`, error);
    }
  };
  const org = input.organizationId;
  const payload = {
    ...input.payload,
    eventType: input.eventType,
    resourceType: input.resourceType ?? null,
    resourceId: input.resourceId ?? null,
  };
  const delivered = new Set<string>();
  const enqueue = async (userId: string, channel: { id: string; kind: string; userId: string }) => {
    const key = `${userId}:${channel.id}`;
    if (delivered.has(key) || channel.userId !== userId ||
        !(await canReceiveNotification(userId, org, { category, payload }))) return;
    delivered.add(key);
    const data = { userId, organizationId: org, auditEventId: input.auditEventId ?? null,
      category, channelId: channel.id, channelKind: channel.kind, status: "queued", attempts: 0, payload };
    if (prepared) prepared.push(data);
    else if (input.idempotencyKey) await source.notificationDelivery.createOnce(input.idempotencyKey, data);
    else await source.notificationDelivery.create(data);
  };
  for (const channelId of new Set(input.destinations?.channelIds ?? [])) await tolerate(async () => {
    const channel = await source.notificationChannel.findById(channelId);
    if (channel?.enabled && channel.verified) await enqueue(channel.userId, channel);
  });
  if (input.destinations && !input.destinations.includeSubscriptions) return;
  const subs = await read(source.notificationSubscription.listEnabledForDispatch(org, category), []);
  for (const sub of subs) await tolerate(async () => {
    const channel = await source.notificationChannel.findById(sub.channelId);
    if (channel?.enabled && channel.verified) await enqueue(sub.userId, channel);
  });
  await tolerate(async () => {
    const def = (await read(source.notificationDefault.listByOrganization(org), [])).find(d => d.category === category);
    if (!(def?.defaultEnabled ?? findCategory(category)?.defaultEnabled ?? false)) return;
    const kinds = (def?.defaultChannelKinds?.length ? def.defaultChannelKinds
      : strict && ["billing.alert", "quota.warning"].includes(category) ? ["email", "in_app"] : ["email"]) as ChannelKind[];
    const touched = new Set(await read(source.notificationSubscription.listUserIdsWithSubscription(org, category), []));
    const members = await read(source.member.listByOrganization(org), []);
    const untouched = members.map(m => m.userId).filter(id => !touched.has(id));
    if (strict) for (const userId of untouched) {
      if (await canReceiveNotification(userId, org, { category, payload })) await source.notificationChannel.ensureAccountChannels(userId);
    }
    const channels = await read(source.notificationChannel.listVerifiedForUsersByKinds(untouched, kinds), []);
    for (const channel of channels) await tolerate(() => enqueue(channel.userId, channel));
  });
}

export const notification = {
  /** Resolve access/preferences outside the transaction; queue with its checkpoint.
   * Workers revalidate membership and destinations before every external send. */
  async prepare(input: NotificationEmitInput & { idempotencyKey: string }): Promise<(database: Database) => Promise<void>> {
    const prepared: PendingDelivery[] = [];
    await dispatch(input, prepared);
    return async database => {
      const delivery = createNotificationDeliveryRepo(database);
      for (const data of prepared) await delivery.createOnce(input.idempotencyKey, data);
    };
  },
  /**
   * Fire-and-forget. Resolves immediately; the dispatch + delivery
   * inserts run in the background. Errors are swallowed (logged).
   * Use this for everything — there's no reason to await delivery
   * enqueuing in the request path.
   */
  emit(input: NotificationEmitInput): void {
    observeCloudNotification(input);
    // Custom jobs can also be TRIGGERED by an event (cheap no-op when unarmed).
    fireJobTriggers(input.eventType, input.organizationId);
    void trackBackgroundWork(dispatch(input).catch((err) => {
      errorDiagnostics.error("platform/engine/lib/notification-dispatcher",
        `[notification] dispatch failed for eventType=${input.eventType}:`,
        err,
      );
    }));
  },

  /**
   * Synchronous variant for unit tests + critical paths where you want
   * to surface a dispatch failure (e.g., security alerts where missing
   * the notification is itself an incident).
   */
  async emitSync(input: NotificationEmitInput): Promise<void> {
    observeCloudNotification(input);
    fireJobTriggers(input.eventType, input.organizationId);
    await dispatch(input);
  },
};
