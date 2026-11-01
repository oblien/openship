import { InstanceOperationSchemas, type InstanceOperations } from "@repo/contracts";
import type { HttpClient } from "./http";
import { createRemoteScopedOperations } from "./resource-client";

/** Transport for existing instance handlers; no local DB, credential rewrite, or permission fallback. */
export function createRemoteInstanceOperations(http: HttpClient): InstanceOperations {
  return createRemoteScopedOperations(http, InstanceOperationSchemas, {
    onboardingStatus: { method: "GET", path: () => "/system/onboarding" },
    configureOnboarding: { method: "POST", path: () => "/system/onboarding" },
    upgradeToAuth: { method: "POST", path: () => "/system/upgrade-to-auth" },
    preflightMigration: { method: "POST", path: () => "/system/migration/preflight" },
    migrateToServer: { method: "POST", path: () => "/system/migration/start" },
    migrateToCloud: { method: "POST", path: () => "/system/migration/start-cloud" },
    exposeTunnel: { method: "POST", path: () => "/system/migration/start-tunnel" },
    switchBack: { method: "POST", path: () => "/system/migration/switch-back" },
    previewExport: { method: "POST", path: () => "/system/data-transfer/preview" },
    exportData: {
      method: "POST",
      path: () => "/system/data-transfer/export",
      redactInvalidResponse: true,
    },
    importData: {
      method: "POST",
      path: () => "/system/data-transfer/import",
      redactInvalidResponse: true,
    },
  });
}
