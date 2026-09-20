/**
 * Retained notification application services for HTTP and native operations.
 *
 * Three concerns, all in one module since they share the same Settings
 * page surface:
 *
 *   1. Channels — per-user delivery destinations (email, webhook, etc.)
 *   2. Subscriptions — per-(user, org, category, channel) toggles
 *   3. Defaults — per-org defaults that apply to new members
 *   4. Deliveries — read-only feed for the in-app bell + history view
 *
 * Authorization: the shared operation layer gates org membership and feature access.
 * INSIDE these services we additionally enforce ownership for per-user objects
 * (channels, subscriptions, deliveries) — a member of org X can't view
 * or modify another member's channels.
 */

import type { ExecutionContext } from "../../../context";
import type { Static } from "@sinclair/typebox";
import { CreateChannelBody, UpdateChannelBody, UpsertSubscriptionBody, UpsertNotificationDefaultBody, NotificationDeliveryQuery, ValidationError, NotFoundError } from "@repo/contracts";
import { repos, type ChannelKind } from "@repo/db";
import { audit, operationAuditContext } from "../../lib/audit-emitter";
import { encrypt } from "@repo/platform/engine/lib/encryption";
import { CATEGORIES, CATEGORY_GROUPS } from "@repo/platform/engine/lib/notification-categories";
import { env } from "@repo/platform/engine/config/env";
import { assertPublicUrlLiteral, SsrfError } from "@repo/platform/engine/lib/ssrf-guard";
import { sendTestToChannel } from "@repo/platform/engine/lib/notification-workers";
import { safeErrorMessage } from "@repo/core";
import { randomBytes } from "node:crypto";
import { canReadNotification } from "../../lib/notification-access";

const VALID_CHANNEL_KINDS = new Set([
  "email",
  "webhook",
  "in_app",
  "slack",
  "discord",
  "msteams",
  "telegram",
]);

/* ─── Categories (static, no DB) ─────────────────────────────────────── */

/**
 * GET /categories — the static registry, plus the groups the Settings UI tabs by.
 *
 * Each group is dropped in the mode that can never produce it: `billing` is fed by
 * Stripe/Oblien so it is cloud-only, and `mail` is fed by the self-hosted mail engine
 * (the whole mail module is absent in cloud) so it is the mirror image. Either way a
 * toggle that can never fire is worse than no toggle.
 *
 * The filter lives HERE and not in `CATEGORIES` on purpose — `findCategory` supplies the
 * title and body of every delivered alert (notification-workers.ts) and the dispatcher's
 * `defaultEnabled` fallback, so the registry has to stay complete or an org that already
 * holds a row for a hidden category would start rendering the raw category id.
 *
 * Both lists are filtered symmetrically: a category whose group is gone would render
 * under no tab at all.
 */
export async function listCategories(ctx: ExecutionContext) {
  const hidden = new Set(env.CLOUD_MODE ? ["mail"] : ["billing"]);
  return ({
    categories: CATEGORIES.filter((cat) => !hidden.has(cat.group)),
    groups: CATEGORY_GROUPS.filter((g) => !hidden.has(g.id)),
  });
}

/* ─── Channels ───────────────────────────────────────────────────────── */

/** GET /channels — list the calling user's channels. */
export async function listChannels(ctx: ExecutionContext) {
  const channels = await repos.notificationChannel.listByUser(ctx.userId);
  // Strip secrets from the config blob before sending to the client.
  return channels.map((ch) => ({ ...ch, config: redactChannelConfig(ch.kind, ch.config as Record<string, unknown>) }));
}

/** POST /channels — create a new channel for the calling user. */
export async function createChannel(ctx: ExecutionContext, body: Static<typeof CreateChannelBody>) {

  if (!VALID_CHANNEL_KINDS.has(body.kind)) {
    throw new ValidationError("Invalid channel kind");
  }
  if (!body.label || typeof body.label !== "string") {
    throw new ValidationError("label is required");
  }

  const config = sanitizeChannelConfig(body.kind, body.config);
  if (!config.ok) throw new ValidationError(config.error);

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

  audit.recordAsync(operationAuditContext(ctx), {
    eventType: "notification_channel.created",
    resourceType: "notifications",
    resourceId: channel.id,
    after: { kind: channel.kind, label: channel.label },
  });

  return ({
    channel: { ...channel, config: redactChannelConfig(channel.kind, channel.config as Record<string, unknown>) },
    // One-time reveal: the signing secret is never returned again.
    ...(config.revealSecret ? { secret: config.revealSecret } : {}),
  });
}

/** PATCH /channels/:id — update a channel the caller owns. */
export async function updateChannel(ctx: ExecutionContext, id: string, body: Static<typeof UpdateChannelBody>) {

  const existing = await repos.notificationChannel.findById(id);
  if (!existing || existing.userId !== ctx.userId) {
    throw new NotFoundError("Channel", id);
  }

  const updates: Record<string, unknown> = {};
  if (typeof body.label === "string") updates.label = body.label;
  if (typeof body.enabled === "boolean") updates.enabled = body.enabled;
  // `verified` is SERVER-SET ONLY (via the test-send endpoint). Never trust a
  // client-supplied value — otherwise a member could flip verified=true on an
  // arbitrary outbound webhook/email channel and exfiltrate org event payloads,
  // bypassing the dispatcher's enabled&&verified gate.

  let revealSecret: string | undefined;
  if (body.config) {
    const config = sanitizeChannelConfig(
      existing.kind,
      body.config,
      existing.config as Record<string, unknown>,
    );
    if (!config.ok) throw new ValidationError(config.error);
    updates.config = config.value;
    revealSecret = config.revealSecret;
    // Config change re-requires verification (the user might have
    // pointed it at a different webhook URL or email).
    if (existing.kind !== "in_app") updates.verified = false;
  }

  const before = { label: existing.label, enabled: existing.enabled, verified: existing.verified };
  const channel = await repos.notificationChannel.update(id, updates);

  audit.recordAsync(operationAuditContext(ctx), {
    eventType: "notification_channel.updated",
    resourceType: "notifications",
    resourceId: id,
    before,
    after: { label: channel?.label, enabled: channel?.enabled, verified: channel?.verified },
  });

  return ({
    channel: channel
      ? {
          ...channel,
          config: redactChannelConfig(channel.kind, channel.config as Record<string, unknown>),
        }
      : null,
    // One-time reveal when a config change generated a new signing secret.
    ...(revealSecret ? { secret: revealSecret } : {}),
  });
}

/**
 * POST /channels/:id/test — send a REAL test delivery via the per-kind worker;
 * on success mark the channel verified (the only path to verified — server-set).
 */
export async function testChannel(ctx: ExecutionContext, id: string) {

  const channel = await repos.notificationChannel.findById(id);
  if (!channel || channel.userId !== ctx.userId) {
    throw new NotFoundError("Channel", id);
  }

  try {
    await sendTestToChannel(channel);
  } catch (err) {
    return { ok: false, error: safeErrorMessage(err) };
  }

  const updated = await repos.notificationChannel.verifyIfUnchanged(channel);
  if (!updated) return { ok: false, error: "Channel changed while testing; test its current configuration again" };
  audit.recordAsync(operationAuditContext(ctx), {
    eventType: "notification_channel.updated",
    resourceType: "notifications",
    resourceId: id,
    after: { action: "test.verified", verified: true },
  });
  return ({ ok: true, verified: updated?.verified ?? true });
}

/** DELETE /channels/:id — remove a channel the caller owns. */
export async function deleteChannel(ctx: ExecutionContext, id: string) {

  const existing = await repos.notificationChannel.findById(id);
  if (!existing || existing.userId !== ctx.userId) {
    throw new NotFoundError("Channel", id);
  }

  await repos.notificationChannel.delete(id);

  audit.recordAsync(operationAuditContext(ctx), {
    eventType: "notification_channel.deleted",
    resourceType: "notifications",
    resourceId: id,
    before: { kind: existing.kind, label: existing.label },
  });

  return ({ ok: true });
}

/* ─── Subscriptions ──────────────────────────────────────────────────── */

/** GET /subscriptions — list calling user's subscriptions for the active org. */
export async function listSubscriptions(ctx: ExecutionContext) {
  const subs = await repos.notificationSubscription.listForUserInOrg(
    ctx.userId,
    ctx.organizationId,
  );
  return subs;
}

/** PUT /subscriptions — idempotent upsert for one subscription toggle. */
export async function upsertSubscription(ctx: ExecutionContext, body: Static<typeof UpsertSubscriptionBody>) {

  if (!body.category || !body.channelId || typeof body.enabled !== "boolean") {
    throw new ValidationError("category, channelId, enabled are required");
  }

  // Channel must belong to the calling user.
  const channel = await repos.notificationChannel.findById(body.channelId);
  if (!channel || channel.userId !== ctx.userId) {
    throw new NotFoundError("Channel", body.channelId);
  }

  const sub = await repos.notificationSubscription.upsert({
    userId: ctx.userId,
    organizationId: ctx.organizationId,
    category: body.category,
    channelId: body.channelId,
    enabled: body.enabled,
  });

  audit.recordAsync(operationAuditContext(ctx), {
    eventType: "notification_subscription.updated",
    resourceType: "notifications",
    resourceId: sub.id,
    after: { category: sub.category, channelId: sub.channelId, enabled: sub.enabled },
  });

  return sub;
}

/** DELETE /subscriptions/:id — remove a subscription. */
export async function deleteSubscription(ctx: ExecutionContext, id: string) {
  await repos.notificationSubscription.delete(id, ctx.userId, ctx.organizationId);
  audit.recordAsync(operationAuditContext(ctx), {
    eventType: "notification_subscription.deleted",
    resourceType: "notifications",
    resourceId: id,
  });
  return ({ ok: true });
}

/* ─── Org defaults (admin only at the route layer) ──────────────────── */

/** GET /defaults — list org defaults. */
export async function listDefaults(ctx: ExecutionContext) {
  const defaults = await repos.notificationDefault.listByOrganization(ctx.organizationId);
  return defaults;
}

/** PUT /defaults — upsert one org default. */
export async function upsertDefault(ctx: ExecutionContext, body: Static<typeof UpsertNotificationDefaultBody>) {

  if (!body.category || typeof body.defaultEnabled !== "boolean") {
    throw new ValidationError("category and defaultEnabled are required");
  }
  // Multi-channel: accept an array of kinds; tolerate the legacy single
  // `defaultChannelKind` string. Dedupe + require a non-empty, all-valid set.
  const rawKinds: unknown[] = Array.isArray(body.defaultChannelKinds)
    ? body.defaultChannelKinds
    : body.defaultChannelKind != null
      ? [body.defaultChannelKind]
      : ["email"];
  const kinds = Array.from(new Set(rawKinds)).filter(
    (k): k is string => typeof k === "string",
  );
  if (kinds.length === 0 || !kinds.every((k) => VALID_CHANNEL_KINDS.has(k))) {
    throw new ValidationError("defaultChannelKinds must be a non-empty list of valid channel kinds");
  }

  const def = await repos.notificationDefault.upsert({
    organizationId: ctx.organizationId,
    category: body.category,
    defaultEnabled: body.defaultEnabled,
    defaultChannelKinds: kinds as ChannelKind[],
  });

  audit.recordAsync(operationAuditContext(ctx), {
    eventType: "notification_default.updated",
    resourceType: "notifications",
    resourceId: `${ctx.organizationId}:${body.category}`,
    after: {
      category: def.category,
      defaultEnabled: def.defaultEnabled,
      defaultChannelKinds: def.defaultChannelKinds,
    },
  });

  return def;
}

/* ─── Deliveries (in-app inbox) ──────────────────────────────────────── */

/** GET /deliveries — calling user's recent deliveries in this org. */
export async function listDeliveries(ctx: ExecutionContext, input: Static<typeof NotificationDeliveryQuery> = {}) {
  const unseenOnly = input.unseen ?? false;
  const limit = input.limit ?? 100;
  const deliveries = [];
  for (let offset = 0; deliveries.length < limit; offset += 250) {
    const rows = await repos.notificationDelivery.listForUser(ctx.userId, ctx.organizationId, { unseenOnly, limit: 250, offset });
    for (const row of rows) if (await canReadNotification(ctx, row)) {
      deliveries.push(row);
      if (deliveries.length === limit) break;
    }
    if (rows.length < 250) break;
  }
  return deliveries;
}

/** GET /deliveries/unseen-count — for the bell icon badge. */
export async function unseenCount(ctx: ExecutionContext) {
  let count = 0;
  for (let offset = 0; ; offset += 250) {
    const rows = await repos.notificationDelivery.listForUser(ctx.userId, ctx.organizationId, { unseenOnly: true, excludeFailed: true, limit: 250, offset });
    for (const row of rows) if (await canReadNotification(ctx, row)) count++;
    if (rows.length < 250) break;
  }
  return count;
}

/** POST /deliveries/:id/seen — mark one delivery seen. */
export async function markSeen(ctx: ExecutionContext, id: string) {
  await repos.notificationDelivery.markSeen(id, ctx.userId, ctx.organizationId);
  audit.recordAsync(operationAuditContext(ctx), { eventType: "notification_delivery.seen", resourceType: "notifications", resourceId: id });
  return ({ ok: true });
}

/* ─── Helpers ────────────────────────────────────────────────────────── */

interface ConfigOk { ok: true; value: Record<string, unknown>; revealSecret?: string }
interface ConfigErr { ok: false; error: string }

/**
 * Sanitize + normalize the inbound config per kind. Secrets (webhook
 * URLs, Slack/Discord/Teams URLs, HMAC keys) are stored encrypted — the
 * dispatcher decrypts at delivery time.
 *
 * Returns either { ok: true, value } or { ok: false, error }.
 */
function sanitizeChannelConfig(
  kind: string,
  raw: unknown,
  existing?: Record<string, unknown>,
): ConfigOk | ConfigErr {
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
      // SaaS SSRF guard: reject internal/loopback/metadata targets at create.
      // Self-hosted operators may webhook their own LAN → gate on CLOUD_MODE.
      // The DNS-rebinding pin runs at fetch time in notification-workers.
      if (env.CLOUD_MODE) {
        try {
          assertPublicUrlLiteral(url, { allowHttp: true });
        } catch (e) {
          return { ok: false, error: e instanceof SsrfError ? e.message : "Invalid webhook URL" };
        }
      }
      // Signing-secret policy (revealSecret is returned to the client EXACTLY
      // ONCE so a receiver can verify X-Openship-Signature-256):
      //   - explicit hmacSecret in the body → (re)set + reveal (create / rotate)
      //   - none supplied but one already stored (an edit of e.g. the URL) → CARRY
      //     the stored secret forward. Do NOT regenerate — that silently breaks
      //     every existing receiver's signature check — and do NOT reveal.
      //   - none supplied and none stored (fresh create) → generate + reveal
      const provided =
        typeof cfg.hmacSecret === "string" && cfg.hmacSecret.length > 0 ? cfg.hmacSecret : null;
      const storedEnc = typeof existing?.hmacSecret === "string" ? existing.hmacSecret : null;
      if (provided) {
        return { ok: true, value: { url, hmacSecret: encrypt(provided) }, revealSecret: provided };
      }
      if (storedEnc) {
        return { ok: true, value: { url, hmacSecret: storedEnc } };
      }
      const generated = randomBytes(32).toString("base64url");
      return { ok: true, value: { url, hmacSecret: encrypt(generated) }, revealSecret: generated };
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
      // Two required inputs, and the token is the secret half. Same carry-forward
      // rule as the webhook HMAC: an edit that only changes the chat id must not
      // wipe the stored token (the client never receives it back to resend).
      const provided = String(cfg.botToken ?? "").trim();
      const storedEnc = typeof existing?.botToken === "string" ? existing.botToken : null;
      if (provided && !/^\d{4,}:[A-Za-z0-9_-]{20,}$/.test(provided)) {
        return { ok: false, error: "Invalid Telegram bot token (expected <id>:<secret>)" };
      }
      if (!provided && !storedEnc) return { ok: false, error: "Telegram bot token is required" };

      // Numeric ids (negative for groups/supergroups) or @publicchannelname.
      const chatId = String(cfg.chatId ?? "").trim();
      if (!/^(-?\d+|@[A-Za-z][A-Za-z0-9_]{4,})$/.test(chatId)) {
        return { ok: false, error: "Invalid Telegram chat ID" };
      }

      const out: Record<string, unknown> = {
        botToken: provided ? encrypt(provided) : storedEnc,
        chatId,
      };
      // The id half of the token is the bot's public user id, not a secret —
      // keep it in the clear so the channel list can say WHICH bot sends.
      const botId = provided ? provided.split(":")[0] : existing?.botId;
      if (botId) out.botId = String(botId);

      const thread = String(cfg.messageThreadId ?? "").trim();
      if (thread) {
        if (!/^\d+$/.test(thread)) return { ok: false, error: "Invalid Telegram topic ID" };
        out.messageThreadId = thread;
      }
      return { ok: true, value: out };
    }
    default:
      return { ok: false, error: `Unsupported channel kind: ${kind}` };
  }
}

/**
 * Strip secrets from the channel config before returning to the client.
 * Email address is non-secret; webhook URL is shown but HMAC secret is
 * masked; Slack/Discord/Teams URLs are masked entirely (showing them
 * would let anyone with dashboard access post to the channel).
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
        botTokenConfigured: !!cfg.botToken,
        botId: cfg.botId ?? null,
        chatId: cfg.chatId ?? "",
        messageThreadId: cfg.messageThreadId ?? null,
      };
    default:
      return {};
  }
}
