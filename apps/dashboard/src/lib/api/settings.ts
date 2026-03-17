import { api } from "./client";
import { endpoints } from "./endpoints";

export type BuildMode = "auto" | "server" | "local";

export interface UserSettingsResponse {
  buildMode: BuildMode;
}

export const settingsApi = {
  /** Get the current user's platform settings */
  get: () => api.get<UserSettingsResponse>(endpoints.settings.get),

  /** Create or update all platform settings */
  upsert: (data: { buildMode: BuildMode }) =>
    api.put<UserSettingsResponse>(endpoints.settings.upsert, data),

  /** Update only the build mode preference */
  updateBuildMode: (buildMode: BuildMode) =>
    api.patch<UserSettingsResponse>(endpoints.settings.buildMode, { buildMode }),
};
