import { Type, type Static } from "@sinclair/typebox";
import { AssistantProviderSchema, type AssistantProvider } from "./assistant";
export const CHAT_APP_PROVIDERS = ["slack", "discord", "telegram", "teams"] as const;
export type ChatAppProvider = (typeof CHAT_APP_PROVIDERS)[number];
export type ChatAppTransport = "outbound" | "webhook";
export const CHAT_APP_PURPOSES = ["assistant", "commands", "both"] as const;
export type ChatAppPurpose = (typeof CHAT_APP_PURPOSES)[number];
export const ChatAppPurposeSchema = Type.Union(CHAT_APP_PURPOSES.map((p) => Type.Literal(p)));
const field = Type.String({ maxLength: 256 });
const ChatAppCreateSchema = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 80 }),
    provider: Type.Union(CHAT_APP_PROVIDERS.map((p) => Type.Literal(p))),
    purpose: Type.Optional(ChatAppPurposeSchema),
    transport: Type.Optional(Type.Union([Type.Literal("outbound"), Type.Literal("webhook")])),
    channelIds: Type.Array(Type.String({ minLength: 1, maxLength: 256 }), {
      minItems: 1,
      maxItems: 20,
      uniqueItems: true,
    }),
    workspaceId: Type.Optional(field),
    applicationId: Type.Optional(field),
    serviceUrl: Type.Optional(Type.String({ maxLength: 512 })),
    credentials: Type.Object(
      {
        botToken: Type.Optional(Type.String({ maxLength: 2048 })),
        appToken: Type.Optional(Type.String({ maxLength: 2048 })),
        signingSecret: Type.Optional(field),
        webhookSecret: Type.Optional(field),
        publicKey: Type.Optional(field),
        clientSecret: Type.Optional(Type.String({ maxLength: 2048 })),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
export const ChatAppInputs = {
  setup: Type.Object(
    {
      provider: Type.Union(CHAT_APP_PROVIDERS.map((p) => Type.Literal(p))),
      purpose: Type.Optional(ChatAppPurposeSchema),
      transport: Type.Optional(Type.Union([Type.Literal("outbound"), Type.Literal("webhook")])),
    },
    { additionalProperties: false },
  ),
  create: ChatAppCreateSchema,
  commands: Type.Object(
    { revision: Type.Integer({ minimum: 1 }) },
    { additionalProperties: false },
  ),
  configuration: Type.Object(
    {
      ...Type.Omit(ChatAppCreateSchema, ["provider"]).properties,
      purpose: ChatAppPurposeSchema,
      revision: Type.Integer({ minimum: 1 }),
    },
    { additionalProperties: false },
  ),
  enable: Type.Object(
    { enabled: Type.Boolean(), revision: Type.Integer({ minimum: 1 }) },
    { additionalProperties: false },
  ),
  purpose: Type.Object(
    { purpose: ChatAppPurposeSchema, revision: Type.Integer({ minimum: 1 }) },
    { additionalProperties: false },
  ),
  assistant: Type.Object(
    {
      identityId: Type.String({ minLength: 1, maxLength: 128 }),
      revision: Type.Integer({ minimum: 1 }),
      enabled: Type.Boolean(),
      provider: Type.Optional(AssistantProviderSchema),
      model: Type.Optional(Type.String({ maxLength: 256 })),
    },
    { additionalProperties: false },
  ),
  pair: Type.Object(
    { challenge: Type.String({ minLength: 32, maxLength: 128 }) },
    { additionalProperties: false },
  ),
  complete: Type.Object(
    {
      state: Type.String({ minLength: 32, maxLength: 128 }),
      code: Type.String({ minLength: 1, maxLength: 2048 }),
    },
    { additionalProperties: false },
  ),
};
export type ChatAppCreate = Static<typeof ChatAppInputs.create>;
export type ChatAppUpdate = Static<typeof ChatAppInputs.configuration>;
/** Editable settings only. Provider credentials are write-only and encrypted in OpenShip. */
export interface ChatAppConfiguration extends ChatAppView {
  channelIds: string[];
  workspaceId?: string;
  applicationId?: string;
  serviceUrl?: string;
}
export interface ChatAppView {
  id: string;
  name: string;
  provider: ChatAppProvider;
  purpose: ChatAppPurpose;
  transport: ChatAppTransport;
  receiver?: {
    state: "connecting" | "connected" | "retrying" | "error" | "paused";
    error?: string;
  };
  enabled: boolean;
  revision: number;
  serverId: string | null;
  webhookUrl: string;
  linked: boolean;
  identityId: string | null;
  assistantAllowed: boolean;
  assistantRevision: number | null;
  assistant: { provider: AssistantProvider; model: string } | null;
  issue?: string;
}
export type ChatAssistantInput = Static<typeof ChatAppInputs.assistant>;
export interface ChatAppsStatus {
  organizationId: string;
  connections: ChatAppView[];
  canManage: boolean;
}
