import { Type, type Static } from "@sinclair/typebox";
import type { ResourceOperationSchema, ResourceOperations, ScopedOperations } from "./resource-operations";

const nullableString = Type.Union([Type.String(), Type.Null()]);
const target = Type.Union([Type.Literal("platform"), Type.Literal("app"), Type.Literal("project"), Type.Literal("mail")]);
const severity = Type.Union([Type.Literal("critical"), Type.Literal("recommended"), Type.Literal("info")]);

export const NoticeAdvisorySchema = Type.Object({
  id: Type.String(), severity, announce: Type.Literal(false), affects: Type.Literal("*"),
  title: Type.String(), message: Type.String(),
  action: Type.Optional(Type.Object({ label: Type.String(), kind: Type.Literal("open-url"), url: Type.String() })),
  target: Type.Optional(Type.Object({ type: target, id: Type.Optional(Type.String()) })),
});
export const NoticeSchema = Type.Object({
  id: Type.String(), severity: Type.String(), title: Type.String(), message: Type.String(),
  actionLabel: nullableString, actionUrl: nullableString, targetType: nullableString, targetId: nullableString,
  active: Type.Boolean(), startsAt: nullableString, endsAt: nullableString,
  createdAt: Type.String(), updatedAt: Type.String(),
});
export const CreateNoticeInputSchema = Type.Object({
  title: Type.String({ minLength: 1, maxLength: 512 }),
  message: Type.String({ minLength: 1, maxLength: 32_768 }),
  // Preserve the HTTP contract: unknown severity/target values normalize in the service.
  severity: Type.Optional(Type.String({ maxLength: 64 })),
  actionLabel: Type.Optional(Type.String({ maxLength: 512 })),
  actionUrl: Type.Optional(Type.String({ maxLength: 4096 })),
  targetType: Type.Optional(Type.String({ maxLength: 64 })),
  targetId: Type.Optional(Type.String({ maxLength: 256 })),
  startsAt: Type.Optional(Type.String({ maxLength: 64 })),
  endsAt: Type.Optional(Type.String({ maxLength: 64 })),
});
export const NoticeCollectionSchemas = {
  list: { action: "read", output: Type.Object({ advisories: Type.Array(NoticeAdvisorySchema) }) },
} as const satisfies Record<string, ResourceOperationSchema>;
export const OperatorNoticeCollectionSchemas = {
  listAll: { action: "read", output: Type.Array(NoticeSchema) },
  create: { action: "admin", input: CreateNoticeInputSchema, output: NoticeSchema },
} as const satisfies Record<string, ResourceOperationSchema>;
export const OperatorNoticeResourceSchemas = {
  remove: { action: "admin", output: Type.Object({ success: Type.Literal(true) }) },
} as const satisfies Record<string, ResourceOperationSchema>;

export type Notice = Static<typeof NoticeSchema>;
export type CreateNoticeInput = Static<typeof CreateNoticeInputSchema>;
export type NoticeOperations = ScopedOperations<typeof NoticeCollectionSchemas>;
/** Installation-wide capability, never included on an ordinary tenant scope. */
export interface OperatorNoticeOperations extends ScopedOperations<typeof OperatorNoticeCollectionSchemas>, ResourceOperations<typeof OperatorNoticeResourceSchemas> {}
