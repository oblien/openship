import { UserSettingsSchemas } from "@repo/contracts";
import type { Authorization } from "./authorization";
import { createScopedOperations, type ScopedServices, type PlatformScopedOperations } from "./resource-operations";
export interface UserSettingsDependencies { collection: ScopedServices<typeof UserSettingsSchemas> }
export type PlatformUserSettingsOperations = PlatformScopedOperations<typeof UserSettingsSchemas>;
export function createUserSettingsOperations(authorization: Authorization, deps?: UserSettingsDependencies): PlatformUserSettingsOperations {
  return createScopedOperations(UserSettingsSchemas, authorization, "settings", deps?.collection);
}
