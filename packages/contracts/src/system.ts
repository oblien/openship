import { Type, type Static } from "@sinclair/typebox";
import type { ResourceOperationSchema, ScopedOperations } from "./resource-operations";

const nullableString = Type.Union([Type.String(), Type.Null()]);
const nullableNumber = Type.Union([Type.Number(), Type.Null()]);
const nullableBoolean = Type.Union([Type.Boolean(), Type.Null()]);
const ok = Type.Object({ ok: Type.Literal(true) });
export const SystemInfoSchema = Type.Object({
  selfHosted: Type.Boolean(), deployMode: Type.String(), isServerHost: Type.Boolean(), hostControlEnabled: Type.Boolean(),
  version: Type.String(), authMode: Type.String(), productMode: Type.String(), teamMode: Type.String(),
  migrationTargetUrl: nullableString, migrationInProgress: Type.Boolean(), cloudAuthUrl: Type.String(), cloudApiUrl: Type.String(),
  machineName: Type.Optional(Type.String()), hostDomain: Type.Optional(Type.String()),
});
export type SystemInfo = Static<typeof SystemInfoSchema>;
export const SystemHealthSchema = Type.Object({
  ok: Type.Boolean(),
  db: Type.Object({ driver: Type.String(), ok: Type.Boolean(), latencyMs: nullableNumber, error: nullableString, migrationsApplied: nullableNumber }),
  projects: Type.Union([Type.Object({ total: Type.Number(), apps: Type.Number() }), Type.Null()]), servicesConfigured: nullableNumber,
  hostChannel: Type.Union([Type.Object({ ok: Type.Boolean(), state: Type.String(), cause: Type.Optional(Type.String()), remedy: Type.Optional(Type.String()) }, { additionalProperties: false }), Type.Null()]),
});
export const BrowseDirectoriesInputSchema = Type.Object({ path: Type.Optional(Type.String({ minLength: 1 })) }, { additionalProperties: false });
export const BrowseDirectoriesSchema = Type.Object({ path: Type.String(), directories: Type.Array(Type.Object({ name: Type.String(), path: Type.String(), isProject: Type.Boolean() })) });
export const InstanceSettingsSchema = Type.Object({
  configured: Type.Boolean(), authMode: Type.String(), tunnelProvider: nullableString, defaultBuildMode: Type.String(),
  defaultRollbackWindow: Type.Number(), invitationMailSource: Type.String(), teamMode: Type.String(), migrationTargetUrl: nullableString, migratedAt: nullableString,
  autoUpdateInfra: Type.Boolean(), autoScanInfra: Type.Boolean(), productMode: nullableString, productModeEffective: Type.String(),
  hostControl: nullableBoolean, hostControlEffective: Type.Boolean(),
  teamReachability: Type.Union([Type.Object({
    configured: Type.Boolean(), url: nullableString, source: nullableString, selfAppInstalled: Type.Boolean(), selfAppProjectId: nullableString,
    selfAppHasDomain: Type.Boolean(), selfAppHasVerifiedDomain: Type.Boolean(),
  }), Type.Null()]),
}, { additionalProperties: false });
export const UpdateInstanceSettingsInputSchema = Type.Object({
  authMode: Type.Optional(Type.String()), confirm: Type.Optional(Type.String()), tunnelProvider: Type.Optional(nullableString), tunnelToken: Type.Optional(nullableString),
  defaultBuildMode: Type.Optional(nullableString), defaultRollbackWindow: Type.Optional(Type.Union([Type.Number(), Type.String(), Type.Null()])),
  invitationMailSource: Type.Optional(Type.String()), autoUpdateInfra: Type.Optional(Type.Boolean()), autoScanInfra: Type.Optional(Type.Boolean()),
  productMode: Type.Optional(nullableString), hostControl: Type.Optional(nullableBoolean),
}, { additionalProperties: false });
export type UpdateInstanceSettingsInput = Static<typeof UpdateInstanceSettingsInputSchema>;
export const InstanceEmailSettingsSchema = Type.Object({
  configured: Type.Boolean(), host: nullableString, port: nullableNumber, user: nullableString, from: nullableString, hasPassword: Type.Boolean(), deliverable: Type.Boolean(),
}, { additionalProperties: false });
export const UpdateInstanceEmailSettingsInputSchema = Type.Object({
  host: Type.Optional(nullableString), port: Type.Optional(Type.Union([Type.String(), Type.Number(), Type.Null()])), user: Type.Optional(nullableString),
  from: Type.Optional(nullableString), password: Type.Optional(nullableString),
}, { additionalProperties: false });
export type UpdateInstanceEmailSettingsInput = Static<typeof UpdateInstanceEmailSettingsInputSchema>;
export const InstanceTestEmailInputSchema = Type.Object({ to: Type.String() }, { additionalProperties: false });
export const InstanceTestEmailResultSchema = Type.Union([ok, Type.Object({ ok: Type.Literal(false), error: Type.String() })]);
export const EdgeOrphanScanSchema = Type.Object({
  scanned: Type.Boolean(), reason: Type.Optional(Type.String()), knownCount: Type.Number(),
  orphans: Type.Array(Type.Object({ hostname: Type.String(), hostnames: Type.Array(Type.String()), kind: Type.Union([Type.Literal("proxy"), Type.Literal("static")]),
    target: Type.String(), ssl: Type.Boolean(), source: Type.Optional(Type.String()) })),
});
export const RemoveEdgeOrphanInputSchema = Type.Object({ hostname: Type.String({ minLength: 1 }) }, { additionalProperties: false });

/** Instance authority is additional to the operation's ordinary settings grant. */
export const SystemOperationSchemas = {
  browse: { action: "read", input: BrowseDirectoriesInputSchema, optionalInput: true, output: BrowseDirectoriesSchema },
  health: { action: "read", instance: true, output: SystemHealthSchema },
  getSettings: { action: "read", output: InstanceSettingsSchema },
  updateSettings: { action: "write", instance: true, input: UpdateInstanceSettingsInputSchema, output: ok },
  getEmailSettings: { action: "read", output: InstanceEmailSettingsSchema },
  updateEmailSettings: { action: "write", instance: true, input: UpdateInstanceEmailSettingsInputSchema, output: Type.Object({ ok: Type.Literal(true), configured: Type.Boolean() }) },
  sendTestEmail: { action: "write", instance: true, input: InstanceTestEmailInputSchema, output: InstanceTestEmailResultSchema },
  resetSettings: { action: "admin", instance: true, output: ok },
  listUntrackedEdgeSites: { action: "read", instance: true, output: EdgeOrphanScanSchema },
  removeUntrackedEdgeSite: { action: "admin", instance: true, input: RemoveEdgeOrphanInputSchema, output: Type.Object({ removed: Type.Literal(true), hostname: Type.String() }) },
} as const satisfies Record<string, ResourceOperationSchema & { instance?: true }>;
export interface SystemOperations extends ScopedOperations<typeof SystemOperationSchemas> {
  /** Public deployment metadata, also available from the HTTP health endpoint. */
  info(): Promise<SystemInfo>;
}
