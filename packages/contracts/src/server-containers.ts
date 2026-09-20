import { Type, type Static } from "@sinclair/typebox";

const nullableString = Type.Union([Type.String(), Type.Null()]);
export const ServerContainerComponentSchema = Type.Union([Type.Literal("edge"), Type.Literal("mail")]);
export const ServerContainerIntentSchema = Type.Union([Type.Literal("update"), Type.Literal("repair")]);
export const ServerContainerInputSchema = Type.Object({ component: ServerContainerComponentSchema }, { additionalProperties: false });
export const ApplyServerContainerInputSchema = Type.Object({
  component: ServerContainerComponentSchema, intent: Type.Optional(ServerContainerIntentSchema),
}, { additionalProperties: false });
export type ServerContainerInput = Static<typeof ServerContainerInputSchema>;
export type ApplyServerContainerInput = Static<typeof ApplyServerContainerInputSchema>;
export const ApplyAllServerContainersInputSchema = Type.Object({
  intents: Type.Optional(Type.Array(ServerContainerIntentSchema, { minItems: 1 })),
}, { additionalProperties: false });

export const ServerContainerViewSchema = Type.Object({
  component: ServerContainerComponentSchema, runningLabel: nullableString, pinnedLabel: Type.String(),
  runningVersion: nullableString, pinnedVersion: nullableString, behind: Type.Boolean(), down: Type.Boolean(),
  containerMissing: Type.Boolean(), flavor: Type.Optional(Type.Union([Type.Literal("container"), Type.Literal("host")])),
});
export const ServerContainerStatusSchema = Type.Object({
  id: Type.String(), organizationId: nullableString, serverId: Type.String(), component: ServerContainerComponentSchema,
  runningLabel: nullableString, pinnedLabel: nullableString, runningVersion: nullableString, pinnedVersion: nullableString,
  behind: Type.Boolean(), latestInProgress: Type.Boolean(),
  detail: Type.Union([Type.Object({
    lastError: Type.Optional(Type.String()), down: Type.Optional(Type.Boolean()), containerMissing: Type.Optional(Type.Boolean()),
    flavor: Type.Optional(Type.Union([Type.Literal("container"), Type.Literal("host")])),
  }), Type.Null()]), checkedAt: Type.String(), createdAt: Type.String(), updatedAt: Type.String(),
});
export const ServerContainerGroupSchema = Type.Object({
  server: Type.Object({ id: Type.String(), name: Type.String(), sshHost: Type.String(), isLocal: Type.Boolean(), projectCount: Type.Number() }),
  components: Type.Array(ServerContainerStatusSchema),
});
export const ServerContainerIssuesSchema = Type.Object({
  total: Type.Number(), edgeDown: Type.Number(), edgeMissing: Type.Number(), mailDown: Type.Number(),
  servers: Type.Array(Type.Object({
    server: Type.Object({ id: Type.String(), name: Type.String() }), component: ServerContainerComponentSchema,
    issue: Type.Union([Type.Literal("down"), Type.Literal("absent")]), containerMissing: Type.Boolean(), reason: Type.Optional(Type.String()),
  })),
});
export const ServerContainerStepSchema = Type.Object({
  id: Type.Union([Type.Literal("pull"), Type.Literal("recreate"), Type.Literal("verify")]), label: Type.String(),
  status: Type.Union([Type.Literal("pending"), Type.Literal("running"), Type.Literal("done"), Type.Literal("error")]),
});
export const ApplyingServerContainersSchema = Type.Object({
  active: Type.Array(Type.Object({
    serverId: Type.String(), serverName: Type.String(), component: ServerContainerComponentSchema,
    state: Type.Union([Type.Literal("queued"), Type.Literal("running")]), intent: Type.Union([ServerContainerIntentSchema, Type.Null()]),
    sessionId: Type.Optional(Type.String()), steps: Type.Optional(Type.Array(ServerContainerStepSchema)), startedAt: Type.Optional(Type.String()),
  })),
  recent: Type.Array(Type.Object({
    serverId: Type.String(), serverName: Type.String(), component: ServerContainerComponentSchema,
    ok: Type.Boolean(), error: Type.Optional(Type.String()), finishedAt: Type.String(),
  })),
});
export const ApplyAllServerContainersResultSchema = Type.Object({
  started: Type.Array(Type.Object({ serverId: Type.String(), serverName: Type.String(), component: ServerContainerComponentSchema, intent: ServerContainerIntentSchema })),
  skipped: Type.Array(Type.Object({
    serverId: Type.String(), serverName: Type.String(), component: ServerContainerComponentSchema,
    reason: Type.Union([Type.Literal("needs_takeover_consent"), Type.Literal("container_missing"), Type.Literal("already_running"), Type.Literal("unreachable")]),
  })),
});
export const ServerContainerApplySessionSchema = Type.Union([
  Type.Object({ active: Type.Literal(false) }),
  Type.Object({ active: Type.Literal(true), sessionId: Type.String(), status: Type.Literal("running"), serverId: Type.String(), component: ServerContainerComponentSchema }),
]);
export type ServerContainerStatus = Static<typeof ServerContainerStatusSchema>;
export type ServerContainerView = Static<typeof ServerContainerViewSchema>;
export type ServerContainerIssues = Static<typeof ServerContainerIssuesSchema>;
export type ApplyAllServerContainersResult = Static<typeof ApplyAllServerContainersResultSchema>;
