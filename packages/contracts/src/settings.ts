import { Type, type Static } from "@sinclair/typebox";
import { UpdateBuildModeBody, UpdateRouteStrategyBody, UpdateDeployDefaultsBody, UpdateCloneStrategyPreferenceBody, UpdateTransferPrefsBody, UpdateForwardGitBody } from "./settings-inputs";
import type { ResourceOperationSchema, ScopedOperations } from "./resource-operations";

const nullableString = Type.Union([Type.String(), Type.Null()]);
const buildMode = UpdateBuildModeBody.properties.buildMode;
const routeStrategy = UpdateRouteStrategyBody.properties.routeStrategy;
const cloneStrategyPreference = UpdateCloneStrategyPreferenceBody.properties.preference;
const deployDefaults = { defaultDeployTarget: Type.Union([Type.Literal("server"), Type.Literal("cloud"), Type.Null()]), defaultServerId: nullableString };
const clone = { cloneToken: Type.Object({ hasToken: Type.Boolean(), setAt: nullableString, asDefault: Type.Boolean() }), cloneStrategyPreference };
const transfer = Type.Required(UpdateTransferPrefsBody);
export const UserSettingsSchema = Type.Object({ buildMode, ...deployDefaults, ...clone, ...transfer.properties, routeStrategy, forwardGitToServer: Type.Boolean() });
export const UserSettingsSchemas = {
  get: { action: "read", output: UserSettingsSchema },
  update: { action: "write", input: Type.Partial(UpdateBuildModeBody), output: Type.Object({ buildMode, ...deployDefaults }) },
  setBuildMode: { action: "write", input: UpdateBuildModeBody, output: UpdateBuildModeBody },
  setRouteStrategy: { action: "write", input: UpdateRouteStrategyBody, output: UpdateRouteStrategyBody },
  setDeployDefaults: { action: "write", input: UpdateDeployDefaultsBody, output: Type.Object(deployDefaults) },
  setCloneCredentials: { action: "write", input: Type.Object({ token: Type.Optional(nullableString), asDefault: Type.Optional(Type.Boolean()) }), output: Type.Object(clone) },
  setCloneStrategy: { action: "write", input: UpdateCloneStrategyPreferenceBody, output: Type.Object({ cloneStrategyPreference }) },
  setTransferPreferences: { action: "write", input: UpdateTransferPrefsBody, output: transfer },
  setGitForwarding: { action: "write", input: UpdateForwardGitBody, output: Type.Object({ forwardGitToServer: Type.Boolean() }) },
} as const satisfies Record<string, ResourceOperationSchema>;
export type UserSettings = Static<typeof UserSettingsSchema>;
export type UserSettingsOperations = ScopedOperations<typeof UserSettingsSchemas>;
