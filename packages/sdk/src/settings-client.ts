import { UserSettingsSchemas, type UserSettingsOperations } from "@repo/contracts";
import type { HttpClient } from "./http";
import { createRemoteScopedOperations } from "./resource-client";
export function createRemoteUserSettingsOperations(http: HttpClient): UserSettingsOperations {
  return createRemoteScopedOperations(http, UserSettingsSchemas, {
    get: { method: "GET", path: () => "/settings" },
    update: { method: "PUT", path: () => "/settings" },
    setBuildMode: { method: "PATCH", path: () => "/settings/build-mode" },
    setRouteStrategy: { method: "PATCH", path: () => "/settings/route-strategy" },
    setDeployDefaults: { method: "PATCH", path: () => "/settings/deploy-defaults" },
    setCloneCredentials: { method: "PATCH", path: () => "/settings/clone-credentials" },
    setCloneStrategy: { method: "PATCH", path: () => "/settings/clone-strategy-preference" },
    setTransferPreferences: { method: "PATCH", path: () => "/settings/transfer" },
    setGitForwarding: { method: "PATCH", path: () => "/settings/forward-git" },
  });
}
