import { DEFAULT_PORT } from "../../core/src/constants";

/** Shared local/public ports used by onboarding and dashboard flows. */
export const LOCAL_API_PORT = DEFAULT_PORT.api;
export const LOCAL_DASHBOARD_PORT = DEFAULT_PORT.dashboard;
export const LOCAL_SAAS_API_PORT = 4100;
export const LOCAL_SAAS_DASHBOARD_PORT = 3002;

/** Cloud & local default URLs */
export const CLOUD_API_URL = "https://api.openship.io";
export const CLOUD_DASHBOARD_URL = "https://app.openship.io";
export const LOCAL_API_URL = `http://localhost:${LOCAL_API_PORT}`;
export const LOCAL_DASHBOARD_URL = `http://localhost:${LOCAL_DASHBOARD_PORT}`;
export const LOCAL_SAAS_API_URL = `http://localhost:${LOCAL_SAAS_API_PORT}`;
export const LOCAL_SAAS_DASHBOARD_URL = `http://localhost:${LOCAL_SAAS_DASHBOARD_PORT}`;

export type DashboardRuntimeTarget = {
  id: "local" | "local-saas" | "cloud-saas";
  dashboard: string;
  api: string;
  selfHosted: boolean;
  deployMode: "docker" | "cloud";
  authMode: "local";
};

/** Shared dashboard/API targets used by local and SaaS flows. */
export const DASHBOARD_RUNTIME_TARGETS = [
  {
    id: "local",
    dashboard: LOCAL_DASHBOARD_URL,
    api: LOCAL_API_URL,
    selfHosted: true,
    deployMode: "docker",
    authMode: "local",
  },
  {
    id: "local-saas",
    dashboard: LOCAL_SAAS_DASHBOARD_URL,
    api: LOCAL_SAAS_API_URL,
    selfHosted: false,
    deployMode: "cloud",
    authMode: "local",
  },
  {
    id: "cloud-saas",
    dashboard: CLOUD_DASHBOARD_URL,
    api: CLOUD_API_URL,
    selfHosted: false,
    deployMode: "cloud",
    authMode: "local",
  },
] as const satisfies readonly DashboardRuntimeTarget[];

/** Known dashboard → API origin pairs used across local and SaaS flows. */
export const DASHBOARD_API_ORIGIN_PAIRS = DASHBOARD_RUNTIME_TARGETS.map(({ dashboard, api }) => ({
  dashboard,
  api,
}));
