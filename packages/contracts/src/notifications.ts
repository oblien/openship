import { Type, type Static } from "@sinclair/typebox";
import { CreateChannelBody, UpdateChannelBody, UpsertSubscriptionBody, UpsertNotificationDefaultBody, NotificationDeliveryQuery } from "./notification-inputs";
import type { ResourceOperationSchema, ResourceOperations, ScopedOperations } from "./resource-operations";

const nullableString = Type.Union([Type.String(), Type.Null()]);
const object = Type.Record(Type.String(), Type.Unknown());
const ok = Type.Object({ ok: Type.Literal(true) });
const timestamps = { createdAt: Type.String(), updatedAt: Type.String() };
export const NotificationChannelSchema = Type.Object({ id: Type.String(), userId: Type.String(), kind: Type.String(), label: Type.String(), config: object, verified: Type.Boolean(), enabled: Type.Boolean(), lastDeliveredAt: nullableString, ...timestamps });
export const NotificationSubscriptionSchema = Type.Object({ id: Type.String(), userId: Type.String(), organizationId: Type.String(), category: Type.String(), channelId: Type.String(), enabled: Type.Boolean(), ...timestamps });
export const NotificationDefaultSchema = Type.Object({ organizationId: Type.String(), category: Type.String(), defaultEnabled: Type.Boolean(), defaultChannelKinds: Type.Array(Type.String()), ...timestamps });
export const NotificationDeliverySchema = Type.Object({ id: Type.String(), userId: Type.String(), organizationId: Type.String(), auditEventId: nullableString, category: Type.String(), channelId: nullableString, channelKind: Type.String(), status: Type.String(), attempts: Type.Integer(), payload: object, lastError: nullableString, createdAt: Type.String(), sentAt: nullableString, seenAt: nullableString });
export const NotificationCollectionSchemas = {
  categories: { action: "read", output: Type.Object({ categories: Type.Array(Type.Object({ id: Type.String(), group: Type.String(), label: Type.String(), description: Type.String(), defaultEnabled: Type.Boolean() })), groups: Type.Array(Type.Object({ id: Type.String(), label: Type.String() })) }) },
  listChannels: { action: "read", output: Type.Array(NotificationChannelSchema) },
  createChannel: { action: "write", input: CreateChannelBody, output: Type.Object({ channel: NotificationChannelSchema, secret: Type.Optional(Type.String()) }) },
  listSubscriptions: { action: "read", output: Type.Array(NotificationSubscriptionSchema) },
  upsertSubscription: { action: "write", input: UpsertSubscriptionBody, output: NotificationSubscriptionSchema },
  listDefaults: { action: "read", output: Type.Array(NotificationDefaultSchema) },
  upsertDefault: { action: "admin", input: UpsertNotificationDefaultBody, output: NotificationDefaultSchema },
  listDeliveries: { action: "read", input: NotificationDeliveryQuery, optionalInput: true, output: Type.Array(NotificationDeliverySchema) },
  unseenCount: { action: "read", output: Type.Integer({ minimum: 0 }) },
} as const satisfies Record<string, ResourceOperationSchema>;
export const NotificationResourceSchemas = {
  updateChannel: { action: "write", input: UpdateChannelBody, output: Type.Object({ channel: Type.Union([NotificationChannelSchema, Type.Null()]), secret: Type.Optional(Type.String()) }) },
  testChannel: { action: "write", output: Type.Union([Type.Object({ ok: Type.Literal(true), verified: Type.Boolean() }), Type.Object({ ok: Type.Literal(false), error: Type.String() })]) },
  removeChannel: { action: "write", output: ok },
  removeSubscription: { action: "write", output: ok },
  markSeen: { action: "write", output: ok },
} as const satisfies Record<string, ResourceOperationSchema>;
export type NotificationChannel = Static<typeof NotificationChannelSchema>;
export type NotificationSubscription = Static<typeof NotificationSubscriptionSchema>;
export type NotificationDelivery = Static<typeof NotificationDeliverySchema>;
export interface NotificationOperations extends ScopedOperations<typeof NotificationCollectionSchemas>, ResourceOperations<typeof NotificationResourceSchemas> {}
