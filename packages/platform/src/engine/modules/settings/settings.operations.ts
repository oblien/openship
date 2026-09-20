import type { UserSettingsDependencies } from "../../../settings";
import type { ExecutionContext } from "../../../context";
import { authorization } from "../../lib/authorization";
import * as service from "./preferences.service";

async function visibleDefault<T extends { defaultServerId: string | null; defaultDeployTarget: "server" | "cloud" | null }>(ctx: ExecutionContext, value: T): Promise<T> {
  if (value.defaultServerId && !(await authorization.checkPermissionOnResource({ ...ctx, scopeMode: "fixed" }, { resourceType: "server", resourceId: value.defaultServerId, action: "read" })))
    return { ...value, defaultServerId: null, defaultDeployTarget: null };
  return value;
}
export const settingsDependencies: UserSettingsDependencies = {
  collection: {
    get: async ctx => visibleDefault(ctx, await service.get(ctx)),
    update: async (ctx, input) => visibleDefault(ctx, await service.upsert(ctx, input)),
    setBuildMode: service.updateBuildMode,
    setRouteStrategy: service.updateRouteStrategy,
    async setDeployDefaults(ctx, input) {
      if (input.defaultDeployTarget === "server" && input.defaultServerId) await authorization.authorize({ ...ctx, scopeMode: "fixed" }, { resourceType: "server", resourceId: input.defaultServerId, action: "read" });
      return service.updateDeployDefaults(ctx, input);
    },
    setCloneCredentials: service.updateCloneCredentials,
    setCloneStrategy: service.updateCloneStrategyPreference,
    setTransferPreferences: service.updateTransferPrefs,
    setGitForwarding: service.updateForwardGitToServer,
  },
};
