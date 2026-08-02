/**
 * GitLab webhook provider — verifies X-Gitlab-Token and dispatches Push Hooks.
 */

import { timingSafeEqual } from "crypto";
import { repos } from "@repo/db";
import { env } from "../../config/env";
import { decrypt } from "../../lib/encryption";
import { handlePush } from "./webhook-push";
import { splitPathWithNamespace } from "./gitlab.service";
import type {
  WebhookProvider,
  WebhookVerifyResult,
  WebhookHandlerResult,
} from "../webhooks/webhook.types";
import type { GitLabPushPayload } from "./gitlab.types";

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

async function collectDeliverySecrets(
  payload: string | Buffer,
): Promise<string[]> {
  let parsed: unknown;
  try {
    const text = Buffer.isBuffer(payload) ? payload.toString("utf8") : payload;
    parsed = JSON.parse(text);
  } catch {
    return [];
  }

  const path = (parsed as GitLabPushPayload)?.project?.path_with_namespace;
  if (!path || typeof path !== "string") return [];
  const parts = splitPathWithNamespace(path);
  if (!parts) return [];

  const secrets = new Set<string>();
  const projects = await repos.project
    .findByGitRepo(parts.owner, parts.repo, "gitlab")
    .catch(() => []);
  for (const p of projects) {
    if (!p.webhookSecret) continue;
    try {
      secrets.add(decrypt(p.webhookSecret));
    } catch {
      // skip
    }
  }
  return [...secrets];
}

export const gitlabWebhookProvider: WebhookProvider = {
  name: "gitlab",

  async verify(
    payload: string | Buffer,
    headers: Record<string, string>,
  ): Promise<WebhookVerifyResult> {
    const token = headers["x-gitlab-token"];
    const candidates = await collectDeliverySecrets(payload);
    if (env.GITLAB_WEBHOOK_SECRET && !candidates.includes(env.GITLAB_WEBHOOK_SECRET)) {
      candidates.push(env.GITLAB_WEBHOOK_SECRET);
    }

    if (candidates.length === 0) {
      return {
        valid: false,
        error: "No webhook secret configured — token cannot be verified",
      };
    }
    if (!token) {
      return { valid: false, error: "Missing X-Gitlab-Token header" };
    }

    const valid = candidates.some((secret) => safeEqual(secret, token));
    if (!valid) {
      return { valid: false, error: "Invalid X-Gitlab-Token" };
    }
    return { valid: true };
  },

  async handle(
    payload: unknown,
    headers: Record<string, string>,
  ): Promise<WebhookHandlerResult> {
    const event =
      headers["x-gitlab-event"] ??
      (payload as GitLabPushPayload)?.object_kind ??
      "unknown";
    const deliveryId =
      headers["x-gitlab-event-uuid"] ??
      headers["x-gitlab-delivery"] ??
      `${event}:${Date.now()}:${Math.random().toString(36).slice(2)}`;

    const claimed = await repos.gitlabWebhookEvent.claim(deliveryId, event);
    if (!claimed) {
      return {
        success: true,
        event,
        message: "Duplicate delivery ignored",
      };
    }

    try {
      const kind =
        (payload as GitLabPushPayload)?.object_kind ??
        (payload as GitLabPushPayload)?.event_name ??
        "";
      const isPush =
        event.toLowerCase().includes("push") ||
        kind === "push" ||
        kind === "Push Hook";

      let result: WebhookHandlerResult;
      if (isPush) {
        result = await handlePush(payload as GitLabPushPayload);
      } else {
        result = {
          success: true,
          event,
          message: `Ignored event type: ${event}`,
        };
      }

      await repos.gitlabWebhookEvent.markProcessed(deliveryId).catch(() => {});
      return result;
    } catch (err) {
      // Leave claim row without processedAt so observability shows failure;
      // GitLab may retry — duplicate claim will short-circuit.
      throw err;
    }
  },
};
