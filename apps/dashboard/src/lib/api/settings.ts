import { api } from "./client";
import { endpoints } from "./endpoints";

export type BuildMode = "auto" | "server" | "local";
export type DefaultDeployTarget = "local" | "server" | "cloud";
export type CloneStrategyPreference = "prompt" | "local" | "remote-with-token";
/** How the edge reaches an app's upstream. See settings.service RouteStrategyPref. */
export type RouteStrategy = "auto" | "loopback-port" | "container-ip";

export interface CloneCredentialsState {
  /** True when the user has a global clone token saved. Token never echoed back. */
  hasToken: boolean;
  /** ISO timestamp when the token was last set, or null if never. */
  setAt: string | null;
  /** Whether the saved token should be used by default during clone. */
  asDefault: boolean;
}

export interface UserSettingsResponse {
  buildMode: BuildMode;
  defaultDeployTarget: DefaultDeployTarget | null;
  defaultServerId: string | null;
  cloneToken: CloneCredentialsState;
  cloneStrategyPreference: CloneStrategyPreference;
  routeStrategy: RouteStrategy;
}

export interface DeployDefaultsResponse {
  defaultDeployTarget: DefaultDeployTarget | null;
  defaultServerId: string | null;
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

  /** Update only the default edge→app route strategy */
  updateRouteStrategy: (routeStrategy: RouteStrategy) =>
    api.patch<{ routeStrategy: RouteStrategy }>(endpoints.settings.routeStrategy, { routeStrategy }),

  /**
   * Update (or clear) the default deploy target.
   * Pass `defaultDeployTarget: null` to clear. When target='server',
   * `defaultServerId` is required.
   */
  updateDeployDefaults: (data: {
    defaultDeployTarget: DefaultDeployTarget | null;
    defaultServerId?: string | null;
  }) => api.patch<DeployDefaultsResponse>(endpoints.settings.deployDefaults, data),

  /**
   * Update the user-global clone credentials.
   *   - token: null/empty → clear
   *   - token: string     → encrypt + store
   *   - asDefault         → whether `resolveCloneToken` should use it
   */
  updateCloneCredentials: (data: { token?: string | null; asDefault?: boolean }) =>
    api.patch<{
      cloneToken: CloneCredentialsState;
      cloneStrategyPreference: CloneStrategyPreference;
    }>(endpoints.settings.cloneCredentials, data),

  /** Save the first-time-deploy nudge choice. */
  updateCloneStrategyPreference: (preference: CloneStrategyPreference) =>
    api.patch<{ cloneStrategyPreference: CloneStrategyPreference }>(
      endpoints.settings.cloneStrategyPreference,
      { preference },
    ),
};
