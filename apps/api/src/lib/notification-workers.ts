/**
 * Notification channel workers.
 *
 * Each channel kind owns its own worker function. The runner loop
 * (runNotificationDeliveryLoop below) polls `notification_delivery`
 * for queued rows and dispatches each one to the worker for its
 * channel kind.
 *
 * Worker contract:
 *   - Input: the delivery row + its resolved channel
 *   - Output: throw on failure (the runner marks it failed/queued for retry)
 *            return normally on success (runner marks sent)
 *
 * The runner handles retry policy uniformly so each worker stays simple.
 */

import { createHmac } from "node:crypto";
import { repos, type NotificationChannel, type NotificationDelivery } from "@repo/db";
import { sendMail } from "./mail";
import { decrypt } from "./encryption";
import { findCategory } from "./notification-categories";
import { env } from "../config/env";
import { safeFetch } from "./safe-fetch";
import { safeErrorMessage } from "@repo/core";

/* ─── Render helpers ─────────────────────────────────────────────────────── */

interface RenderedMessage {
  /** Short headline shown in inbox previews + email subject. */
  title: string;
  /** Body text. Plain text — workers wrap it for their format. */
  body: string;
}

/**
 * Turn a delivery's payload into a human-readable message. We use the
 * category for the title (stable across event types) and pull relevant
 * payload fields into the body. Channel-specific formatting (HTML for
 * email, Slack blocks) wraps this primitive output.
 */
function renderMessage(delivery: NotificationDelivery): RenderedMessage {
  const cat = findCategory(delivery.category);
  const payload = (delivery.payload ?? {}) as Record<string, unknown>;

  const title = cat?.label ?? delivery.category;

  // Build a body from the payload's most useful fields. Workers can
  // override formatting if they want — Slack does because blocks beat
  // plain text — but this default works for email + webhook + in-app.
  const lines: string[] = [];

  if (cat?.description) lines.push(cat.description);
  if (payload.message) lines.push(String(payload.message));

  if (payload.branch) lines.push(`Branch: ${payload.branch}`);
  if (payload.commitSha) {
    const sha = String(payload.commitSha).slice(0, 8);
    lines.push(`Commit: ${sha}`);
  }
  if (payload.url) lines.push(`URL: ${payload.url}`);
  if (payload.errorMessage) lines.push(`Error: ${payload.errorMessage}`);
  if (payload.durationMs) {
    lines.push(`Duration: ${Math.round(Number(payload.durationMs) / 1000)}s`);
  }

  const resourceId = payload.resourceId;
  if (resourceId) {
    const resourceType = payload.resourceType ?? "resource";
    lines.push(`Resource: ${resourceType} (${resourceId})`);
  }

  return {
    title,
    body: lines.join("\n"),
  };
}

/* ─── Chat-webhook payload builders ───────────────────────────────────────── */

// Slack Block Kit caps a `section` text object at 3000 characters and a
// `header` plain_text at 150; a Discord embed caps `title` at 256 and
// `description` at 4096.
const SLACK_HEADER_LIMIT = 150;
const SLACK_SECTION_LIMIT = 3000;
const DISCORD_TITLE_LIMIT = 256;
const DISCORD_DESCRIPTION_LIMIT = 4096;

// The Slack section body is wrapped in a ```…``` code fence — reserve its width
// so the wrapped text still fits SLACK_SECTION_LIMIT.
const SLACK_CODE_FENCE_OVERHEAD = "```\n".length + "\n```".length;

/** Clamp `text` to `max` characters, marking a cut with a trailing ellipsis. */
function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

interface SlackMessage {
  text: string;
  blocks: Array<Record<string, unknown>>;
}

/** Slack incoming-webhook payload for a rendered message, clamped to Slack's
 *  block-text limits. */
export function buildSlackMessage(input: { title: string; body: string }): SlackMessage {
  const title = truncate(input.title, SLACK_HEADER_LIMIT);
  const body = truncate(input.body, SLACK_SECTION_LIMIT - SLACK_CODE_FENCE_OVERHEAD);
  return {
    text: title,
    blocks: [
      { type: "header", text: { type: "plain_text", text: title } },
      { type: "section", text: { type: "mrkdwn", text: "```\n" + body + "\n```" } },
    ],
  };
}

interface DiscordMessage {
  username: string;
  avatar_url: string;
  embeds: Array<Record<string, unknown>>;
}

/** Discord webhook payload (single embed) for a rendered message, clamped to
 *  Discord's embed title/description limits. */
export function buildDiscordMessage(input: {
  title: string;
  body: string;
  timestamp: string;
}): DiscordMessage {
  return {
    username: "Openship",
    avatar_url: "https://openship.io/favicon.ico",
    embeds: [
      {
        title: truncate(input.title, DISCORD_TITLE_LIMIT),
        description: truncate(input.body, DISCORD_DESCRIPTION_LIMIT),
        color: 0x3b82f6,
        timestamp: input.timestamp,
      },
    ],
  };
}

/* ─── Channel workers ─────────────────────────────────────────────────────── */

async function sendEmail(
  delivery: NotificationDelivery,
  channel: NotificationChannel,
): Promise<void> {
  const config = channel.config as { address?: string };
  if (!config?.address) {
    throw new Error("Email channel has no address configured");
  }

  const { title, body } = renderMessage(delivery);
  await sendMail({
    to: config.address,
    subject: `[Openship] ${title}`,
    text: body,
    html: `<pre style="font-family:system-ui,sans-serif;font-size:14px">${escapeHtml(body)}</pre>`,
  });
}

/** Validate a webhook URL to prevent SSRF. */
function assertPublicWebhookUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Webhook URL is malformed");
  }
  if (parsed.protocol !== "https:") {
    throw new Error("Webhook URL must use HTTPS");
  }
  const host = parsed.hostname.toLowerCase();
  const blocked =
    host === "localhost" ||
    host === "0.0.0.0" ||
    host === "::1" ||
    host === "127.0.0.1" ||
    host.endsWith(".local") ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^0\./.test(host) ||
    host === "[::1]";
  if (blocked) {
    throw new Error(`Webhook URL targets a private or loopback host: ${host}`);
  }
}

async function sendWebhook(
  delivery: NotificationDelivery,
  channel: NotificationChannel,
): Promise<void> {
  const config = channel.config as { url?: string; hmacSecret?: string };
  if (!config?.url) {
    throw new Error("Webhook channel has no URL configured");
  }
  assertPublicWebhookUrl(config.url);

  const payload = (delivery.payload ?? {}) as Record<string, unknown>;
  const body = JSON.stringify({
    id: delivery.id,
    category: delivery.category,
    organizationId: delivery.organizationId,
    resourceType: payload.resourceType ?? null,
    resourceId: payload.resourceId ?? null,
    payload,
    createdAt: delivery.createdAt,
  });

  // HMAC signature so the receiver can verify the request came from
  // Openship. The secret is set when the user creates the channel and
  // stored encrypted in channel.config — we sign the raw body.
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": "Openship-Webhook/1.0",
  };
  if (config.hmacSecret) {
    // The secret is encrypt()'d at storage time (see
    // notifications.controller sanitizeChannelConfig). Decrypt before
    // signing — otherwise we sign with ciphertext and the receiver's
    // HMAC verify always fails.
    const secret = decrypt(config.hmacSecret);
    const sig = createHmac("sha256", secret).update(body).digest("hex");
    headers["X-Openship-Signature-256"] = `sha256=${sig}`;
  }

  // SSRF-safe delivery: safeFetch resolves once, pins the validated IP (closes
  // the DNS-rebind window a validate-then-fetch leaves open), preserves SNI/Host,
  // and never follows a 3xx into the internal network (maxRedirects defaults to 0,
  // so a 3xx is non-2xx → thrown). Multi-tenant (CLOUD_MODE) always rejects
  // internal targets; a single-tenant box can opt into its own LAN with
  // NOTIFY_WEBHOOK_ALLOW_INTERNAL.
  const allowPrivate = !env.CLOUD_MODE && env.NOTIFY_WEBHOOK_ALLOW_INTERNAL;
  const res = await safeFetch(config.url, {
    method: "POST",
    headers,
    body,
    timeoutMs: 10_000,
    allowHttp: true,
    allowPrivate,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Webhook returned ${res.status}: ${text.slice(0, 200)}`);
  }
}

async function sendInApp(_delivery: NotificationDelivery): Promise<void> {
  // In-app delivery is "done" the moment the delivery row exists — the
  // dashboard reads notification_delivery directly for the bell-icon
  // inbox. The runner will mark this as sent immediately on return.
}

async function sendDiscord(
  delivery: NotificationDelivery,
  channel: NotificationChannel,
): Promise<void> {
  const config = channel.config as { webhookUrl?: string };
  if (!config?.webhookUrl) {
    throw new Error("Discord channel has no webhook URL configured");
  }

  // Webhook URL is encrypted at storage time.
  const webhookUrl = decrypt(config.webhookUrl);

  const { title, body } = renderMessage(delivery);
  const discordPayload = buildDiscordMessage({
    title,
    body,
    timestamp: new Date(delivery.createdAt).toISOString(),
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(discordPayload),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Discord webhook returned ${res.status}: ${text.slice(0, 200)}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

async function sendSlack(
  delivery: NotificationDelivery,
  channel: NotificationChannel,
): Promise<void> {
  const config = channel.config as { webhookUrl?: string; channelName?: string };
  if (!config?.webhookUrl) {
    throw new Error("Slack channel has no webhook URL configured");
  }

  // The webhook URL is encrypt()'d at storage time. Decrypt before
  // POSTing — sending ciphertext to fetch() would fail URL parsing.
  const webhookUrl = decrypt(config.webhookUrl);

  const { title, body } = renderMessage(delivery);
  const slackPayload = buildSlackMessage({ title, body });

  // SSRF-safe: the Slack (or compatible) webhook URL is user-configured, so pin
  // the resolved IP just like the generic webhook path.
  const allowPrivate = !env.CLOUD_MODE && env.NOTIFY_WEBHOOK_ALLOW_INTERNAL;
  const res = await safeFetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(slackPayload),
    timeoutMs: 10_000,
    allowPrivate,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Slack webhook returned ${res.status}: ${text.slice(0, 200)}`);
  }
}

async function sendMSTeams(
  delivery: NotificationDelivery,
  channel: NotificationChannel,
): Promise<void> {
  const config = channel.config as { webhookUrl?: string };
  if (!config?.webhookUrl) {
    throw new Error("Microsoft Teams channel has no webhook URL configured");
  }

  // Webhook URL is encrypted at storage time.
  const webhookUrl = decrypt(config.webhookUrl);

  const { title, body } = renderMessage(delivery);
  // Adaptive Card in the "message" envelope — the shape accepted by both
  // Power Automate Workflows and legacy Office 365 connectors.
  const teamsPayload = {
    type: "message",
    attachments: [
      {
        contentType: "application/vnd.microsoft.card.adaptive",
        contentUrl: null,
        content: {
          $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
          type: "AdaptiveCard",
          // 1.2 is the highest card version legacy connectors render; the
          // card only uses 1.0-level elements so nothing is lost.
          version: "1.2",
          body: [
            { type: "TextBlock", text: title, weight: "Bolder", size: "Medium", wrap: true },
            { type: "TextBlock", text: body, wrap: true },
          ],
        },
      },
    ],
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(teamsPayload),
      signal: controller.signal,
    });
    // Note: Power Automate Workflows respond 202 even when the flow fails
    // downstream — a 2xx means "accepted", not "delivered".
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Microsoft Teams webhook returned ${res.status}: ${text.slice(0, 200)}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

/* ─── Worker registry ─────────────────────────────────────────────────────── */

const WORKERS: Record<
  string,
  (delivery: NotificationDelivery, channel: NotificationChannel) => Promise<void>
> = {
  email: sendEmail,
  webhook: sendWebhook,
  in_app: sendInApp,
  slack: sendSlack,
  discord: sendDiscord,
  msteams: sendMSTeams,
};

/**
 * Send a one-off TEST notification to a channel, reusing the exact per-kind
 * worker — so a passing test proves real delivery works. The verify endpoint
 * gates channel `verified` on this. Throws on failure (the caller surfaces it).
 */
export async function sendTestToChannel(channel: NotificationChannel): Promise<void> {
  const worker = WORKERS[channel.kind];
  if (!worker) throw new Error(`No worker for channel kind "${channel.kind}"`);
  const testDelivery = {
    id: "test",
    category: "test",
    payload: {
      message: "Openship test notification — this channel is configured correctly.",
    },
  } as unknown as NotificationDelivery;
  await worker(testDelivery, channel);
}

/* ─── Runner loop ─────────────────────────────────────────────────────────── */

const MAX_ATTEMPTS = 5;

/**
 * Process all currently-queued deliveries. Called by a periodic timer
 * (started in app.ts boot) every few seconds. Each invocation claims a
 * batch of queued rows, sends them concurrently, and marks the results.
 *
 * Retry policy:
 *   - Transient failures (worker throws): up to MAX_ATTEMPTS attempts,
 *     backoff via the next scheduled tick (no in-process delay — keeps
 *     the loop simple and the DB row visibly "queued" between tries)
 *   - Permanent failures (channel missing, malformed config): mark
 *     failed immediately, surface in the dashboard
 */
export async function processQueuedNotifications(): Promise<void> {
  const queued = await repos.notificationDelivery.claimQueued(25).catch(() => []);
  if (queued.length === 0) return;

  await Promise.all(
    queued.map(async (delivery) => {
      await repos.notificationDelivery.markSending(delivery.id).catch(() => {});

      // Resolve channel — null channelId means the subscription pointed
      // at a now-deleted channel. Mark failed permanently.
      if (!delivery.channelId) {
        await repos.notificationDelivery.markFailed(delivery.id, "Channel deleted", false);
        return;
      }
      const channel = await repos.notificationChannel
        .findById(delivery.channelId)
        .catch(() => undefined);
      if (!channel) {
        await repos.notificationDelivery.markFailed(delivery.id, "Channel not found", false);
        return;
      }

      const worker = WORKERS[channel.kind];
      if (!worker) {
        await repos.notificationDelivery.markFailed(
          delivery.id,
          `No worker for channel kind "${channel.kind}"`,
          false,
        );
        return;
      }

      try {
        await worker(delivery, channel);
        await repos.notificationDelivery.markSent(delivery.id);
        await repos.notificationChannel.touchLastDelivered(channel.id).catch(() => {});
      } catch (err) {
        const message = safeErrorMessage(err);
        const attempts = delivery.attempts + 1;
        const retry = attempts < MAX_ATTEMPTS;
        await repos.notificationDelivery.markFailed(delivery.id, message, retry);
        if (!retry) {
          console.error(
            `[notification] delivery ${delivery.id} failed permanently after ${attempts} attempts:`,
            message,
          );
        }
      }
    }),
  );
}

let runnerInterval: ReturnType<typeof setInterval> | null = null;

/** Start the periodic runner. Called from app.ts boot. */
export function startNotificationRunner(intervalMs = 5000): void {
  if (runnerInterval) return;
  runnerInterval = setInterval(() => {
    void processQueuedNotifications().catch((err) =>
      console.error("[notification] runner tick failed:", err),
    );
  }, intervalMs);
}

export function stopNotificationRunner(): void {
  if (runnerInterval) {
    clearInterval(runnerInterval);
    runnerInterval = null;
  }
}

/* ─── Helpers ─────────────────────────────────────────────────────────────── */

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
