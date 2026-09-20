import { NotificationCollectionSchemas, NotificationResourceSchemas, type NotificationOperations } from "@repo/contracts";
import type { HttpClient } from "./http";
import { createRemoteResourceOperations, createRemoteScopedOperations } from "./resource-client";

export function createRemoteNotificationOperations(http: HttpClient): NotificationOperations {
  return Object.freeze({
    ...createRemoteScopedOperations(http, NotificationCollectionSchemas, {
      categories: { method: "GET", path: () => "/notifications/categories" },
      listChannels: { method: "GET", path: () => "/notifications/channels", envelope: "channels" },
      createChannel: { method: "POST", path: () => "/notifications/channels" },
      listSubscriptions: { method: "GET", path: () => "/notifications/subscriptions", envelope: "subscriptions" },
      upsertSubscription: { method: "PUT", path: () => "/notifications/subscriptions", envelope: "subscription" },
      listDefaults: { method: "GET", path: () => "/notifications/defaults", envelope: "defaults" },
      upsertDefault: { method: "PUT", path: () => "/notifications/defaults", envelope: "default" },
      listDeliveries: { method: "GET", path: () => "/notifications/deliveries", envelope: "deliveries" },
      unseenCount: { method: "GET", path: () => "/notifications/deliveries/unseen-count", envelope: "count" },
    }),
    ...createRemoteResourceOperations(http, NotificationResourceSchemas, {
      updateChannel: { method: "PATCH", path: id => `/notifications/channels/${encodeURIComponent(id)}` },
      testChannel: { method: "POST", path: id => `/notifications/channels/${encodeURIComponent(id)}/test`, resultStatuses: [400] },
      removeChannel: { method: "DELETE", path: id => `/notifications/channels/${encodeURIComponent(id)}` },
      removeSubscription: { method: "DELETE", path: id => `/notifications/subscriptions/${encodeURIComponent(id)}` },
      markSeen: { method: "POST", path: id => `/notifications/deliveries/${encodeURIComponent(id)}/seen` },
    }),
  });
}
