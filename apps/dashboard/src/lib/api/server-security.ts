import type { ServerSecurityResult, HostPatchPlan, JobRun } from "@repo/contracts";
import { api } from "./client";
const path = (id: string) => `/system/servers/${encodeURIComponent(id)}/security`;
export const serverSecurityApi = {
  get: (id: string) => api.get<{ data: ServerSecurityResult }>(path(id)),
  check: (id: string) =>
    api.post<{ data: ServerSecurityResult }>(path(id) + "/check", undefined, { timeout: 60_000 }),
  plan: (id: string, advisoryId: string, operation: "install" | "reboot" = "install") =>
    api.post<{ data: HostPatchPlan }>(
      path(id) + "/plan",
      { advisoryId, operation },
      { timeout: 150_000 },
    ),
  apply: (id: string, token: string) =>
    api.post<{ data: { runId: string } }>(path(id) + "/apply", { token }),
  runs: (id: string) => api.get<{ data: JobRun[] }>(path(id) + "/runs"),
};
