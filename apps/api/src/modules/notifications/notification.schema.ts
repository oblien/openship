import { Type } from "@sinclair/typebox";

/**
 * Request-body schemas for the notification channel/subscription routes.
 * Declared once and wired via `spec.body` (auto-validates + types the MCP tool).
 *
 * `config` is intentionally an OPEN object: its required sub-fields depend on
 * `kind` and are validated per-kind inside `sanitizeChannelConfig`. We surface
 * the known fields for agent clarity but keep `additionalProperties: true` so
 * this top-level validator never rejects a body the controller would accept.
 */

const ChannelKind = Type.Union(
  [
    Type.Literal("email"),
    Type.Literal("webhook"),
    Type.Literal("in_app"),
    Type.Literal("slack"),
    Type.Literal("discord"),
    Type.Literal("msteams"),
    Type.Literal("telegram"),
  ],
  { description: "Channel delivery kind." },
);

const ChannelConfig = Type.Object(
  {
    address: Type.Optional(Type.String({ description: "email: recipient address." })),
    url: Type.Optional(Type.String({ description: "webhook: HTTPS endpoint URL." })),
    hmacSecret: Type.Optional(Type.String({ description: "webhook: optional HMAC signing secret." })),
    webhookUrl: Type.Optional(Type.String({ description: "slack/discord/msteams: incoming webhook URL." })),
    channelName: Type.Optional(Type.String({ description: "slack: optional channel name." })),
    botToken: Type.Optional(Type.String({ description: "telegram: BotFather bot token." })),
    chatId: Type.Optional(Type.String({ description: "telegram: chat/group/channel id." })),
    messageThreadId: Type.Optional(
      Type.String({ description: "telegram: optional forum topic id." }),
    ),
  },
  { additionalProperties: true, description: "Kind-dependent delivery config." },
);

/** POST /channels */
export const CreateChannelBody = Type.Object({
  kind: ChannelKind,
  label: Type.String({ description: "Human label for the channel." }),
  config: Type.Optional(ChannelConfig),
});

/** PATCH /channels/:id — all optional; only present fields are applied. */
export const UpdateChannelBody = Type.Object({
  label: Type.Optional(Type.String()),
  enabled: Type.Optional(Type.Boolean()),
  config: Type.Optional(ChannelConfig),
});

/** PUT /subscriptions */
export const UpsertSubscriptionBody = Type.Object({
  category: Type.String({ description: "Notification category id (e.g. deploy.failed)." }),
  channelId: Type.String({ description: "Target channel id (must belong to the caller)." }),
  enabled: Type.Boolean(),
});
