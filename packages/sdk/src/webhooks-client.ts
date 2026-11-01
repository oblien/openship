import { WebhookProjectSchemas, WebhookResourceSchemas, WebhookCollectionSchemas, type WebhookOperations } from "@repo/contracts";
import type { HttpClient } from "./http";
import { createRemoteResourceOperations, createRemoteChildResourceOperations, createRemoteScopedOperations } from "./resource-client";

const root = (id: string) => `/projects/${encodeURIComponent(id)}/incoming-webhooks`;
const hook = (projectId: string, id: string) => `${root(projectId)}/${encodeURIComponent(id)}`;
export function createRemoteWebhookOperations(http: HttpClient): WebhookOperations {
  return Object.freeze({
    ...createRemoteResourceOperations(http, WebhookProjectSchemas, {
      list: { method: "GET", path: root, envelope: "data" },
      create: { method: "POST", path: root, envelope: "data" },
      deliveries: { method: "GET", path: id => `/projects/${encodeURIComponent(id)}/webhook-deliveries`, envelope: "data" },
    }),
    ...createRemoteChildResourceOperations(http, WebhookResourceSchemas, {
      update: { method: "PATCH", path: hook, envelope: "data" },
      remove: { method: "DELETE", path: hook, envelope: "data" },
      rotate: { method: "POST", path: (projectId, id) => `${hook(projectId, id)}/rotate`, envelope: "data" },
      hookDeliveries: { method: "GET", path: (projectId, id) => `${hook(projectId, id)}/deliveries`, envelope: "data" },
      invoke: { method: "POST", path: (projectId, id) => `${hook(projectId, id)}/invoke`, envelope: "data" },
    }),
    ...createRemoteScopedOperations(http, WebhookCollectionSchemas, {
      listDeliveries: { method: "GET", path: () => "/settings/webhook-deliveries", envelope: "data" },
    }),
  });
}
