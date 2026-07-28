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

import { repos } from "@repo/db";
import type { ChannelKind } from "@repo/db";
import { categoryForEventType, findCategory } from "./notification-categories";
import { fireJobTriggers } from "../modules/jobs/job-events";

export interface NotificationEmitInput {
  organizationId: string;
  /** The audit_event.event_type. Used for category mapping + the
   *  payload-snapshot subject line. */
  eventType: string;
  /** Optional id of the audit_event row that caused this. Lets the
   *  Settings UI cross-link a notification to its source event. */
  auditEventId?: string;
  resourceType?: string;
  resourceId?: string;
  /** Free-form payload — channel workers render this with their own
   *  template (subject + body for email, JSON for webhook, etc.). */
  payload?: Record<string, unknown>;
}

async function dispatch(input: NotificationEmitInput): Promise<void> {
  const category = categoryForEventType(input.eventType);
  if (!category) return; // not a notifiable event — drop silently

  const org = input.organizationId;
  // Dedupe across both delivery tiers, keyed by (user, channel).
  const delivered = new Set<string>();

  const enqueue = async (
    userId: string,
    channel: { id: string; kind: string },
  ): Promise<void> => {
    const key = `${userId}:${channel.id}`;
    if (delivered.has(key)) return;
    delivered.add(key);
    await repos.notificationDelivery.create({
      userId,
      organizationId: org,
      auditEventId: input.auditEventId ?? null,
      category,
      channelId: channel.id,
      channelKind: channel.kind,
      status: "queued",
      attempts: 0,
      payload: {
        eventType: input.eventType,
        resourceType: input.resourceType ?? null,
        resourceId: input.resourceId ?? null,
        ...input.payload,
      },
    });
  };

  // ── Tier 1: explicit per-user subscriptions (enabled) → their exact channels.
  const subs = await repos.notificationSubscription
    .listEnabledForDispatch(org, category)
    .catch(() => []);
  for (const sub of subs) {
    try {
      const channel = await repos.notificationChannel.findById(sub.channelId);
      if (!channel || !channel.enabled || !channel.verified) continue;
      await enqueue(sub.userId, channel);
    } catch (err) {
      console.error(
        `[notification] failed to enqueue for sub=${sub.id} category=${category}:`,
        err,
      );
    }
  }

  // ── Tier 2: org-default fallback. For members who have made NO explicit
  // choice for this category, deliver when the category is default-enabled
  // (org override else the built-in default) on their verified channels of the
  // default kinds. This is what makes "important" events (deploy.failed,
  // backup.failed, job.run.failed, …) notify everyone by default without a
  // per-user opt-in — the previously-missing consumer of notification_default.
  try {
    const def = (await repos.notificationDefault.listByOrganization(org).catch(() => [])).find(
      (d) => d.category === category,
    );
    const defaultEnabled = def?.defaultEnabled ?? findCategory(category)?.defaultEnabled ?? false;
    if (defaultEnabled) {
      const kinds = (
        def?.defaultChannelKinds?.length ? def.defaultChannelKinds : ["email"]
      ) as ChannelKind[];
      const touched = new Set(
        await repos.notificationSubscription
          .listUserIdsWithSubscription(org, category)
          .catch(() => []),
      );
      const members = await repos.member.listByOrganization(org).catch(() => []);
      const untouched = members.map((m) => m.userId).filter((id) => !touched.has(id));
      const channels = await repos.notificationChannel
        .listVerifiedForUsersByKinds(untouched, kinds)
        .catch(() => []);
      for (const channel of channels) {
        try {
          await enqueue(channel.userId, channel);
        } catch (err) {
          console.error(
            `[notification] default-fallback enqueue failed for user=${channel.userId} category=${category}:`,
            err,
          );
        }
      }
    }
  } catch (err) {
    console.error(`[notification] default-fallback failed for category=${category}:`, err);
  }
}

export const notification = {
  /**
   * Fire-and-forget. Resolves immediately; the dispatch + delivery
   * inserts run in the background. Errors are swallowed (logged).
   * Use this for everything — there's no reason to await delivery
   * enqueuing in the request path.
   */
  emit(input: NotificationEmitInput): void {
    // Custom jobs can also be TRIGGERED by an event (cheap no-op when unarmed).
    fireJobTriggers(input.eventType);
    void dispatch(input).catch((err) => {
      console.error(
        `[notification] dispatch failed for eventType=${input.eventType}:`,
        err,
      );
    });
  },

  /**
   * Synchronous variant for unit tests + critical paths where you want
   * to surface a dispatch failure (e.g., security alerts where missing
   * the notification is itself an incident).
   */
  async emitSync(input: NotificationEmitInput): Promise<void> {
    fireJobTriggers(input.eventType);
    await dispatch(input);
  },
};
