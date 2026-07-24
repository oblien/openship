import { api } from "./client";
import { endpoints } from "./endpoints";

/* ── Static category registry shape (mirrors backend) ────────────── */

export interface NotificationCategory {
  id: string;
  label: string;
  description: string;
  defaultEnabled: boolean;
}

export type ChannelKind = "email" | "webhook" | "in_app" | "slack" | "discord" | "msteams";
export type DeliveryStatus = "queued" | "sending" | "sent" | "failed" | "seen";

/* ── Channel ─────────────────────────────────────────────────────── */

export interface NotificationChannel {
  id: string;
  userId: string;
  kind: ChannelKind;
  label: string;
  /** Config with secrets redacted. Shape depends on kind:
   *    email   → { address }
   *    webhook → { url, hmacSecretConfigured }
   *    in_app  → {}
   *    slack   → { webhookUrlConfigured, channelName | null }
   *    discord → { webhookUrlConfigured }
   *    msteams → { webhookUrlConfigured } */
  config: Record<string, unknown>;
  verified: boolean;
  enabled: boolean;
  lastDeliveredAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface NotificationSubscription {
  id: string;
  userId: string;
  organizationId: string;
  category: string;
  channelId: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface NotificationDefault {
  organizationId: string;
  category: string;
  defaultEnabled: boolean;
  defaultChannelKind: ChannelKind;
  createdAt: string;
  updatedAt: string;
}

export interface NotificationDelivery {
  id: string;
  userId: string;
  organizationId: string;
  category: string;
  channelId: string | null;
  channelKind: string;
  status: DeliveryStatus;
  attempts: number;
  payload: Record<string, unknown>;
  lastError: string | null;
  createdAt: string;
  sentAt: string | null;
  seenAt: string | null;
}

/* ── API client ──────────────────────────────────────────────────── */

export const notificationsApi = {
  // ── Categories
  listCategories: () =>
    api.get<{ categories: NotificationCategory[] }>(endpoints.notifications.categories),

  // ── Channels
  listChannels: () =>
    api.get<{ channels: NotificationChannel[] }>(endpoints.notifications.channels),

  createChannel: (data: { kind: ChannelKind; label: string; config: Record<string, unknown> }) =>
    api.post<{ channel: NotificationChannel }>(endpoints.notifications.channels, data),

  updateChannel: (
    id: string,
    data: Partial<{
      label: string;
      enabled: boolean;
      verified: boolean;
      config: Record<string, unknown>;
    }>,
  ) => api.patch<{ channel: NotificationChannel }>(endpoints.notifications.channel(id), data),

  deleteChannel: (id: string) => api.delete<{ ok: true }>(endpoints.notifications.channel(id)),

  // Sends a real test message through the channel's worker; on success the
  // server flips `verified: true` (the only way to prove reachability). Throws
  // with the provider's error message on failure.
  testChannel: (id: string) =>
    api.post<{ ok: boolean; verified: boolean }>(endpoints.notifications.channelTest(id), {}),

  // ── Subscriptions
  listSubscriptions: () =>
    api.get<{ subscriptions: NotificationSubscription[] }>(endpoints.notifications.subscriptions),

  upsertSubscription: (data: { category: string; channelId: string; enabled: boolean }) =>
    api.put<{ subscription: NotificationSubscription }>(
      endpoints.notifications.subscriptions,
      data,
    ),

  deleteSubscription: (id: string) =>
    api.delete<{ ok: true }>(endpoints.notifications.subscription(id)),

  // ── Defaults (admin only)
  listDefaults: () =>
    api.get<{ defaults: NotificationDefault[] }>(endpoints.notifications.defaults),

  upsertDefault: (data: {
    category: string;
    defaultEnabled: boolean;
    defaultChannelKind: ChannelKind;
  }) => api.put<{ default: NotificationDefault }>(endpoints.notifications.defaults, data),

  // ── Deliveries (in-app inbox)
  listDeliveries: (opts?: { unseen?: boolean; limit?: number }) => {
    const params = new URLSearchParams();
    if (opts?.unseen) params.set("unseen", "true");
    if (opts?.limit) params.set("limit", String(opts.limit));
    const qs = params.toString();
    const url = qs
      ? `${endpoints.notifications.deliveries}?${qs}`
      : endpoints.notifications.deliveries;
    return api.get<{ deliveries: NotificationDelivery[] }>(url);
  },

  unseenCount: () => api.get<{ count: number }>(endpoints.notifications.unseenCount),

  markSeen: (id: string) => api.post<{ ok: true }>(endpoints.notifications.markSeen(id), {}),
};
