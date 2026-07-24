/**
 * Notifications controller — HTTP handlers for the Settings UI.
 *
 * Three concerns, all in one module since they share the same Settings
 * page surface:
 *
 *   1. Channels — per-user delivery destinations (email, webhook, etc.)
 *   2. Subscriptions — per-(user, org, category, channel) toggles
 *   3. Defaults — per-org defaults that apply to new members
 *   4. Deliveries — read-only feed for the in-app bell + history view
 *
 * Authorization: the route middleware gates "user is a member of org X".
 * INSIDE handlers we additionally enforce ownership for per-user objects
 * (channels, subscriptions, deliveries) — a member of org X can't view
 * or modify another member's channels.
 */

import type { Context } from "hono";
import { repos } from "@repo/db";
import { getRequestContext } from "../../lib/request-context";
import { audit, auditContextFrom } from "../../lib/audit";
import { encrypt } from "../../lib/encryption";
import { CATEGORIES } from "../../lib/notification-categories";
import { randomBytes } from "node:crypto";

const VALID_CHANNEL_KINDS = new Set(["email", "webhook", "in_app", "slack", "discord", "msteams", "telegram"]);

/* ─── Categories (static, no DB) ─────────────────────────────────────── */

/** GET /categories — list every notification category (static registry). */
export async function listCategories(c: Context) {
  return c.json({ categories: CATEGORIES });
}

/* ─── Channels ───────────────────────────────────────────────────────── */

/** GET /channels — list the calling user's channels. */
export async function listChannels(c: Context) {
  const ctx = getRequestContext(c);
  const channels = await repos.notificationChannel.listByUser(ctx.userId);
  // Strip secrets from the config blob before sending to the client.
  return c.json({
    channels: channels.map((ch) => ({
      ...ch,
      config: redactChannelConfig(ch.kind, ch.config as Record<string, unknown>),
    })),
  });
}

/** POST /channels — create a new channel for the calling user. */
export async function createChannel(c: Context) {
  const ctx = getRequestContext(c);
  const body = await c.req.json();

  if (!VALID_CHANNEL_KINDS.has(body.kind)) {
    return c.json({ error: "Invalid channel kind" }, 400);
  }
  if (!body.label || typeof body.label !== "string") {
    return c.json({ error: "label is required" }, 400);
  }

  const config = sanitizeChannelConfig(body.kind, body.config);
  if (!config.ok) return c.json({ error: config.error }, 400);

  const channel = await repos.notificationChannel.create({
    userId: ctx.userId,
    kind: body.kind,
    label: body.label,
    config: config.value,
    // In-app is always verified — nothing to prove. Other kinds require
    // explicit verification (test email/webhook/slack), set via PATCH.
    verified: body.kind === "in_app",
    enabled: true,
  });

  audit.recordAsync(auditContextFrom(c, ctx.organizationId, ctx.userId), {
    eventType: "notification_channel.created",
    resourceType: "notifications",
    resourceId: channel.id,
    after: { kind: channel.kind, label: channel.label },
  });

  return c.json({
    channel: {
      ...channel,
      config: redactChannelConfig(channel.kind, channel.config as Record<string, unknown>),
    },
  });
}

/** PATCH /channels/:id — update a channel the caller owns. */
export async function updateChannel(c: Context) {
  const ctx = getRequestContext(c);
  const id = c.req.param("id");
  if (!id) return c.json({ error: "id is required" }, 400);

  const existing = await repos.notificationChannel.findById(id);
  if (!existing || existing.userId !== ctx.userId) {
    return c.json({ error: "Channel not found" }, 404);
  }

  const body = await c.req.json();
  const updates: Record<string, unknown> = {};
  if (typeof body.label === "string") updates.label = body.label;
  if (typeof body.enabled === "boolean") updates.enabled = body.enabled;
  if (typeof body.verified === "boolean") updates.verified = body.verified;

  if (body.config) {
    const config = sanitizeChannelConfig(existing.kind, body.config);
    if (!config.ok) return c.json({ error: config.error }, 400);
    updates.config = config.value;
    // Config change re-requires verification (the user might have
    // pointed it at a different webhook URL or email).
    if (existing.kind !== "in_app") updates.verified = false;
  }

  const before = { label: existing.label, enabled: existing.enabled, verified: existing.verified };
  const channel = await repos.notificationChannel.update(id, updates);

  audit.recordAsync(auditContextFrom(c, ctx.organizationId, ctx.userId), {
    eventType: "notification_channel.updated",
    resourceType: "notifications",
    resourceId: id,
    before,
    after: { label: channel?.label, enabled: channel?.enabled, verified: channel?.verified },
  });

  return c.json({
    channel: channel
      ? {
          ...channel,
          config: redactChannelConfig(channel.kind, channel.config as Record<string, unknown>),
        }
      : null,
  });
}

/** DELETE /channels/:id — remove a channel the caller owns. */
export async function deleteChannel(c: Context) {
  const ctx = getRequestContext(c);
  const id = c.req.param("id");
  if (!id) return c.json({ error: "id is required" }, 400);

  const existing = await repos.notificationChannel.findById(id);
  if (!existing || existing.userId !== ctx.userId) {
    return c.json({ error: "Channel not found" }, 404);
  }

  await repos.notificationChannel.delete(id);

  audit.recordAsync(auditContextFrom(c, ctx.organizationId, ctx.userId), {
    eventType: "notification_channel.deleted",
    resourceType: "notifications",
    resourceId: id,
    before: { kind: existing.kind, label: existing.label },
  });

  return c.json({ ok: true });
}

/* ─── Subscriptions ──────────────────────────────────────────────────── */

/** GET /subscriptions — list calling user's subscriptions for the active org. */
export async function listSubscriptions(c: Context) {
  const ctx = getRequestContext(c);
  const subs = await repos.notificationSubscription.listForUserInOrg(
    ctx.userId,
    ctx.organizationId,
  );
  return c.json({ subscriptions: subs });
}

/** PUT /subscriptions — idempotent upsert for one subscription toggle. */
export async function upsertSubscription(c: Context) {
  const ctx = getRequestContext(c);
  const body = await c.req.json();

  if (!body.category || !body.channelId || typeof body.enabled !== "boolean") {
    return c.json({ error: "category, channelId, enabled are required" }, 400);
  }

  // Channel must belong to the calling user.
  const channel = await repos.notificationChannel.findById(body.channelId);
  if (!channel || channel.userId !== ctx.userId) {
    return c.json({ error: "Channel not found" }, 404);
  }

  const sub = await repos.notificationSubscription.upsert({
    userId: ctx.userId,
    organizationId: ctx.organizationId,
    category: body.category,
    channelId: body.channelId,
    enabled: body.enabled,
  });

  audit.recordAsync(auditContextFrom(c, ctx.organizationId, ctx.userId), {
    eventType: "notification_subscription.updated",
    resourceType: "notifications",
    resourceId: sub.id,
    after: { category: sub.category, channelId: sub.channelId, enabled: sub.enabled },
  });

  return c.json({ subscription: sub });
}

/** DELETE /subscriptions/:id — remove a subscription. */
export async function deleteSubscription(c: Context) {
  const ctx = getRequestContext(c);
  const id = c.req.param("id");
  if (!id) return c.json({ error: "id is required" }, 400);
  await repos.notificationSubscription.delete(id, ctx.userId, ctx.organizationId);
  audit.recordAsync(auditContextFrom(c, ctx.organizationId, ctx.userId), {
    eventType: "notification_subscription.deleted",
    resourceType: "notifications",
    resourceId: id,
  });
  return c.json({ ok: true });
}

/* ─── Org defaults (admin only at the route layer) ──────────────────── */

/** GET /defaults — list org defaults. */
export async function listDefaults(c: Context) {
  const ctx = getRequestContext(c);
  const defaults = await repos.notificationDefault.listByOrganization(ctx.organizationId);
  return c.json({ defaults });
}

/** PUT /defaults — upsert one org default. */
export async function upsertDefault(c: Context) {
  const ctx = getRequestContext(c);
  const body = await c.req.json();

  if (!body.category || typeof body.defaultEnabled !== "boolean") {
    return c.json({ error: "category and defaultEnabled are required" }, 400);
  }
  const kind = body.defaultChannelKind ?? "email";
  if (!VALID_CHANNEL_KINDS.has(kind)) {
    return c.json({ error: "Invalid defaultChannelKind" }, 400);
  }

  const def = await repos.notificationDefault.upsert({
    organizationId: ctx.organizationId,
    category: body.category,
    defaultEnabled: body.defaultEnabled,
    defaultChannelKind: kind,
  });

  audit.recordAsync(auditContextFrom(c, ctx.organizationId, ctx.userId), {
    eventType: "notification_default.updated",
    resourceType: "notifications",
    resourceId: `${ctx.organizationId}:${body.category}`,
    after: {
      category: def.category,
      defaultEnabled: def.defaultEnabled,
      defaultChannelKind: def.defaultChannelKind,
    },
  });

  return c.json({ default: def });
}

/* ─── Deliveries (in-app inbox) ──────────────────────────────────────── */

/** GET /deliveries — calling user's recent deliveries in this org. */
export async function listDeliveries(c: Context) {
  const ctx = getRequestContext(c);
  const unseenOnly = c.req.query("unseen") === "true";
  const limit = Math.min(parseInt(c.req.query("limit") ?? "100", 10) || 100, 500);
  const deliveries = await repos.notificationDelivery.listForUser(ctx.userId, ctx.organizationId, {
    unseenOnly,
    limit,
  });
  return c.json({ deliveries });
}

/** GET /deliveries/unseen-count — for the bell icon badge. */
export async function unseenCount(c: Context) {
  const ctx = getRequestContext(c);
  const count = await repos.notificationDelivery.unseenCount(ctx.userId, ctx.organizationId);
  return c.json({ count });
}

/** POST /deliveries/:id/seen — mark one delivery seen. */
export async function markSeen(c: Context) {
  const ctx = getRequestContext(c);
  const id = c.req.param("id");
  if (!id) return c.json({ error: "id is required" }, 400);
  await repos.notificationDelivery.markSeen(id, ctx.userId, ctx.organizationId);
  return c.json({ ok: true });
}

/* ─── Helpers ────────────────────────────────────────────────────────── */

interface ConfigOk {
  ok: true;
  value: Record<string, unknown>;
}
interface ConfigErr {
  ok: false;
  error: string;
}

/**
 * Sanitize + normalize the inbound config per kind. Secrets (webhook
 * URLs, Slack/Discord/Teams URLs, Telegram bot tokens, HMAC keys) are
 * stored encrypted — the dispatcher decrypts at delivery time.
 *
 * Returns either { ok: true, value } or { ok: false, error }.
 */
function sanitizeChannelConfig(kind: string, raw: unknown): ConfigOk | ConfigErr {
  const cfg = (raw ?? {}) as Record<string, unknown>;
  switch (kind) {
    case "email": {
      const address = String(cfg.address ?? "").trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) {
        return { ok: false, error: "Invalid email address" };
      }
      return { ok: true, value: { address } };
    }
    case "webhook": {
      const url = String(cfg.url ?? "").trim();
      if (!/^https?:\/\//.test(url)) return { ok: false, error: "Invalid webhook URL" };
      // Auto-generate a signing secret if the user didn't supply one —
      // we'll show it back via the verification flow so they can save it.
      const rawSecret =
        typeof cfg.hmacSecret === "string" && cfg.hmacSecret.length > 0
          ? cfg.hmacSecret
          : randomBytes(32).toString("base64url");
      return { ok: true, value: { url, hmacSecret: encrypt(rawSecret) } };
    }
    case "in_app":
      return { ok: true, value: {} };
    case "slack": {
      const webhookUrl = String(cfg.webhookUrl ?? "").trim();
      if (!webhookUrl.startsWith("https://hooks.slack.com/")) {
        return { ok: false, error: "Invalid Slack webhook URL" };
      }
      const out: Record<string, unknown> = { webhookUrl: encrypt(webhookUrl) };
      if (typeof cfg.channelName === "string") out.channelName = cfg.channelName;
      return { ok: true, value: out };
    }
    case "discord": {
      const webhookUrl = String(cfg.webhookUrl ?? "").trim();
      if (
        !webhookUrl.startsWith("https://discord.com/api/webhooks/") &&
        !webhookUrl.startsWith("https://discordapp.com/api/webhooks/")
      ) {
        return { ok: false, error: "Invalid Discord webhook URL" };
      }
      const out: Record<string, unknown> = { webhookUrl: encrypt(webhookUrl) };
      return { ok: true, value: out };
    }
    case "msteams": {
      const webhookUrl = String(cfg.webhookUrl ?? "").trim();
      if (!webhookUrl) return { ok: false, error: "Invalid Microsoft Teams webhook URL" };
      // Power Automate Workflows live on *.logic.azure.com; legacy
      // connectors on *.webhook.office.com. Suffix-match the hostname so
      // lookalike domains (e.g. evil-logic.azure.com.attacker.io) fail.
      try {
        const parsed = new URL(webhookUrl);
        if (
          parsed.protocol !== "https:" ||
          !(
            parsed.hostname.endsWith(".logic.azure.com") ||
            parsed.hostname.endsWith(".webhook.office.com")
          )
        ) {
          return { ok: false, error: "Invalid Microsoft Teams webhook URL" };
        }
      } catch {
        return { ok: false, error: "Invalid Microsoft Teams webhook URL" };
      }
      return { ok: true, value: { webhookUrl: encrypt(webhookUrl) } };
    }
    case "telegram": {
      const token = String(cfg.token ?? "").trim();
      const chatId = String(cfg.chatId ?? "").trim();
      if (!/^\d+:[a-zA-Z0-9_-]+$/.test(token)) {
        return { ok: false, error: "Invalid Telegram bot token" };
      }
      if (!/^-?\d+$/.test(chatId)) {
        return { ok: false, error: "Invalid Telegram chat ID" };
      }
      return { ok: true, value: { token: encrypt(token), chatId } };
    }
    default:
      return { ok: false, error: `Unsupported channel kind: ${kind}` };
  }
}

/**
 * Strip secrets from the channel config before returning to the client.
 * Email address is non-secret; webhook URL is shown but HMAC secret is
 * masked; Slack/Discord/Teams URLs and Telegram bot tokens are masked
 * entirely (showing them would let anyone with dashboard access post
 * to the channel).
 */
function redactChannelConfig(
  kind: string,
  cfg: Record<string, unknown> | null,
): Record<string, unknown> {
  if (!cfg) return {};
  switch (kind) {
    case "email":
      return { address: cfg.address ?? "" };
    case "webhook":
      return {
        url: cfg.url ?? "",
        hmacSecretConfigured: !!cfg.hmacSecret,
      };
    case "in_app":
      return {};
    case "slack":
      return {
        webhookUrlConfigured: !!cfg.webhookUrl,
        channelName: cfg.channelName ?? null,
      };
    case "discord":
      return {
        webhookUrlConfigured: !!cfg.webhookUrl,
      };
    case "msteams":
      return {
        webhookUrlConfigured: !!cfg.webhookUrl,
      };
    case "telegram":
      return {
        tokenConfigured: !!cfg.token,
        chatId: cfg.chatId ?? null,
      };
    default:
      return {};
  }
}
