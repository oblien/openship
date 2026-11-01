import { Type, type Static } from "@sinclair/typebox";
import { CreateIncomingWebhookBody, UpdateIncomingWebhookBody } from "./incoming-webhook-inputs";
import type { ResourceOperationSchema, ResourceOperations, ChildResourceOperations, ScopedOperations } from "./resource-operations";
export { CreateIncomingWebhookBody, UpdateIncomingWebhookBody } from "./incoming-webhook-inputs";

const nullableString = Type.Union([Type.String(), Type.Null()]);
const action = Type.Union([Type.Literal("deploy"), Type.Literal("job")]);
export const IncomingWebhookSchema = Type.Object({
  id: Type.String(), projectId: Type.String(), name: Type.String(), enabled: Type.Boolean(),
  actionType: action,
  actionConfig: Type.Object({ serviceId: Type.Optional(Type.String()), serviceIds: Type.Optional(Type.Array(Type.String())), jobKey: Type.Optional(Type.String()) }),
  authMode: Type.Union([Type.Literal("token"), Type.Literal("hmac"), Type.Literal("none")]),
  url: Type.String(), secret: nullableString, lastFiredAt: nullableString, createdAt: Type.String(),
  requiresReauthorization: Type.Optional(Type.Boolean()),
});
export const WebhookDeliverySchema = Type.Object({
  id: Type.String(), source: Type.String(), event: Type.String(), outcome: Type.String(),
  hookId: nullableString, projectId: nullableString, actionRef: nullableString, authResult: nullableString,
  statusCode: Type.Union([Type.Integer(), Type.Null()]), error: nullableString, summary: Type.Unknown(),
  receivedAt: Type.String(), processedAt: nullableString,
});
export const WebhookPageInputSchema = Type.Object({ cursor: Type.Optional(Type.String({ maxLength: 1024 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })) });
export const WebhookDeliveryPageSchema = Type.Object({ deliveries: Type.Array(WebhookDeliverySchema), nextCursor: Type.Optional(Type.String()) });
export const WebhookProjectSchemas = {
  list: { action: "read", output: Type.Array(IncomingWebhookSchema) },
  create: { action: "write", input: CreateIncomingWebhookBody, output: IncomingWebhookSchema },
  deliveries: { action: "read", input: WebhookPageInputSchema, optionalInput: true, output: WebhookDeliveryPageSchema },
} as const satisfies Record<string, ResourceOperationSchema>;
export const WebhookResourceSchemas = {
  update: { action: "write", input: UpdateIncomingWebhookBody, output: IncomingWebhookSchema },
  rotate: { action: "write", output: IncomingWebhookSchema },
  remove: { action: "write", output: Type.Object({ ok: Type.Literal(true) }) },
  hookDeliveries: { action: "read", input: WebhookPageInputSchema, optionalInput: true, output: WebhookDeliveryPageSchema },
  invoke: { action: "write", output: Type.Object({ action, ref: Type.Optional(Type.String()) }) },
} as const satisfies Record<string, ResourceOperationSchema>;
export const WebhookCollectionSchemas = {
  listDeliveries: { action: "read", input: WebhookPageInputSchema, optionalInput: true, output: WebhookDeliveryPageSchema },
} as const satisfies Record<string, ResourceOperationSchema>;
export type IncomingWebhook = Static<typeof IncomingWebhookSchema>;
export type WebhookDelivery = Static<typeof WebhookDeliverySchema>;
export interface WebhookOperations extends ResourceOperations<typeof WebhookProjectSchemas>, ChildResourceOperations<typeof WebhookResourceSchemas>, ScopedOperations<typeof WebhookCollectionSchemas> {}
