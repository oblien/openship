import { isResourceOutput, SystemOperationSchemas, SystemInfoSchema, type SystemOperations } from "@repo/contracts";
import { ApiError } from "./errors";
import type { HttpClient } from "./http";
import { createRemoteScopedOperations } from "./resource-client";

export function createRemoteSystemOperations(http: HttpClient): SystemOperations {
  return Object.freeze({
    ...createRemoteScopedOperations(http, SystemOperationSchemas, {
      browse: { method: "GET", path: () => "/system/browse" },
      health: { method: "GET", path: () => "/system/diagnostics" },
      getSettings: { method: "GET", path: () => "/system/settings" },
      updateSettings: { method: "PATCH", path: () => "/system/settings" },
      resetSettings: { method: "DELETE", path: () => "/system/settings" },
      getEmailSettings: { method: "GET", path: () => "/system/settings/email" },
      updateEmailSettings: { method: "PUT", path: () => "/system/settings/email" },
      sendTestEmail: { method: "POST", path: () => "/system/settings/email/test", resultStatuses: [400] },
      listUntrackedEdgeSites: { method: "GET", path: () => "/system/edge/untracked", envelope: "data" },
      removeUntrackedEdgeSite: { method: "POST", path: () => "/system/edge/untracked/remove", envelope: "data" },
    }),
    async info() {
      const result = await http.request("/health/env");
      if (!isResourceOutput({ action: "read", output: SystemInfoSchema }, result)) throw new ApiError("Invalid system information response", 502, result);
      return result;
    },
  });
}
