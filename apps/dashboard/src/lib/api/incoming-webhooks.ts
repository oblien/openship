import { api } from "./client";
import { endpoints } from "./endpoints";

export type IncomingWebhookActionType = "deploy" | "job";
export type IncomingWebhookAuthMode = "token" | "hmac" | "none";

export interface IncomingWebhookActionConfig {
  /** deploy: restrict the redeploy to this service (omit = whole project). */
  serviceId?: string;
  /** job: the job key to run. */
  jobKey?: string;
}

/** Owner-facing view of a hook — includes the delivery URL + revealed secret. */
export interface IncomingWebhook {
  id: string;
  projectId: string;
  name: string;
  enabled: boolean;
  actionType: IncomingWebhookActionType;
  actionConfig: IncomingWebhookActionConfig;
  authMode: IncomingWebhookAuthMode;
  url: string;
  secret: string | null;
  lastFiredAt: string | null;
  createdAt: string;
}

export interface CreateIncomingWebhookBody {
  name: string;
  actionType: IncomingWebhookActionType;
  actionConfig: IncomingWebhookActionConfig;
  authMode: IncomingWebhookAuthMode;
}

export type UpdateIncomingWebhookBody = Partial<CreateIncomingWebhookBody> & { enabled?: boolean };

/** One row in the webhook delivery feed (GitHub push, custom hook, or backup). */
export interface WebhookDelivery {
  id: string;
  source: "github" | "incoming" | "backup" | string;
  event: string;
  outcome: "received" | "dispatched" | "skipped" | "forwarded" | "ignored" | "failed" | string;
  hookId: string | null;
  projectId: string | null;
  actionRef: string | null;
  authResult: string | null;
  statusCode: number | null;
  error: string | null;
  summary: { repo?: string; branch?: string; commit?: string; name?: string } | null;
  receivedAt: string;
  processedAt: string | null;
}

export interface WebhookDeliveryPage {
  deliveries: WebhookDelivery[];
  nextCursor?: string;
}

const pageQuery = (opts?: { cursor?: string; limit?: number }) => {
  const q = new URLSearchParams();
  if (opts?.cursor) q.set("cursor", opts.cursor);
  if (opts?.limit) q.set("limit", String(opts.limit));
  const s = q.toString();
  return s ? `?${s}` : "";
};

export const incomingWebhooksApi = {
  list: (projectId: string) =>
    api.get<{ data: IncomingWebhook[] }>(endpoints.projects.incomingWebhooks(projectId)),

  create: (projectId: string, body: CreateIncomingWebhookBody) =>
    api.post<{ data: IncomingWebhook }>(endpoints.projects.incomingWebhooks(projectId), body),

  update: (projectId: string, hookId: string, body: UpdateIncomingWebhookBody) =>
    api.patch<{ data: IncomingWebhook }>(endpoints.projects.incomingWebhook(projectId, hookId), body),

  rotate: (projectId: string, hookId: string) =>
    api.post<{ data: IncomingWebhook }>(endpoints.projects.incomingWebhookRotate(projectId, hookId), {}),

  remove: (projectId: string, hookId: string) =>
    api.delete<{ data: { ok: true } }>(endpoints.projects.incomingWebhook(projectId, hookId)),

  /** Paginated webhook delivery feed for a project (GitHub pushes + custom hooks). */
  deliveries: (projectId: string, opts?: { cursor?: string; limit?: number }) =>
    api.get<{ data: WebhookDeliveryPage }>(
      endpoints.projects.webhookDeliveries(projectId) + pageQuery(opts),
    ),

  /** Paginated deliveries for one incoming hook. */
  hookDeliveries: (projectId: string, hookId: string, opts?: { cursor?: string; limit?: number }) =>
    api.get<{ data: WebhookDeliveryPage }>(
      endpoints.projects.incomingWebhookDeliveries(projectId, hookId) + pageQuery(opts),
    ),

  /** Org-wide delivery feed (incl. forwarded/unmatched GitHub pushes). */
  orgDeliveries: (opts?: { cursor?: string; limit?: number }) =>
    api.get<{ data: WebhookDeliveryPage }>(`settings/webhook-deliveries${pageQuery(opts)}`),
};
