import {
  parseInput, ResourceIdSchema, ListDeploymentsSchema, DeploymentLogsSchema, RedeploySchema,
  RespondSchema, PinSchema, SkipPortCheckSchema, isRecord, isDeployment,
  isCreateDeploymentResult, isDeploymentPage, isDeploymentLogs, isDeploymentBuildStatus,
  isDeploymentRestorePlan, isCancellationResult, type DeploymentResourceOperations,
  DeploymentControlSchemas, DeploymentSslSchemas,
} from "@repo/contracts";
import type { HttpClient } from "./http";
import { ApiError } from "./errors";
import { createRemoteResourceOperations, createRemoteScopedOperations } from "./resource-client";

export function createRemoteDeploymentResources(http: HttpClient): DeploymentResourceOperations {
  const path = (id: string, suffix = "") => "/deployments/" + encodeURIComponent(parseInput(ResourceIdSchema, id)) + suffix;
  function checked<T>(value: unknown, guard: (value: unknown) => value is T): T {
    if (!guard(value)) throw new ApiError("Invalid deployment response", 502, value);
    return value;
  }
  const success = (value: unknown): value is { success: boolean } => isRecord(value) && typeof value.success === "boolean";
  async function data<T>(url: string, guard: (value: unknown) => value is T, body?: unknown): Promise<T> {
    const response = await http.request<unknown>(url, body === undefined ? undefined : { method: "POST", body: JSON.stringify(body) });
    return checked(isRecord(response) ? response.data : undefined, guard);
  }
  async function post(url: string, body: unknown = {}) {
    return http.request<unknown>(url, { method: "POST", body: JSON.stringify(body) });
  }
  return Object.freeze({
    ...createRemoteScopedOperations(http, DeploymentSslSchemas, {
      sslStatus: { method: "POST", path: () => "/deployments/ssl/status" },
      renewSsl: { method: "POST", path: () => "/deployments/ssl/renew" },
    }),
    ...createRemoteResourceOperations(http, DeploymentControlSchemas, {
      containerInfo: { method: "GET", path: id => path(id, "/info"), envelope: "data" },
      containerUsage: { method: "GET", path: id => path(id, "/usage"), envelope: "data" },
      pendingActions: { method: "GET", path: id => path(id, "/pending"), envelope: "data" },
    }),
    get: (id) => data(path(id), isDeployment),
    async list(value = {}) {
      const input = parseInput(ListDeploymentsSchema, value);
      const url = http.url("/deployments");
      for (const [key, value] of Object.entries(input)) if (value !== undefined) url.searchParams.set(key, String(value));
      return checked(await http.request(url.href), isDeploymentPage);
    },
    async logs(id, value = {}) {
      const input = parseInput(DeploymentLogsSchema, value);
      const url = http.url(path(id, "/logs"));
      if (input.tail !== undefined) url.searchParams.set("tail", String(input.tail));
      return data(url.href, isDeploymentLogs);
    },
    async buildStatus(id) { return checked(await http.request(path(id, "/build")), isDeploymentBuildStatus); },
    restorePlan: (id) => data(path(id, "/restore-plan"), isDeploymentRestorePlan),
    async cancel(id) { return checked(await post(path(id, "/cancel")), isCancellationResult); },
    async respond(id, value) { return checked(await post(path(id, "/build/respond"), parseInput(RespondSchema, value)), success); },
    rollback: (id) => data(path(id, "/rollback"), isDeployment, {}),
    async redeploy(id, value = {}) { return checked(await post(path(id, "/redeploy"), parseInput(RedeploySchema, value)), isCreateDeploymentResult); },
    pin: (id, value = {}) => data(path(id, "/pin"), isDeployment, parseInput(PinSchema, value)),
    async keep(id) {
      const result = checked(await post(path(id, "/keep")), success);
      const deployment = checked((result as Record<string, unknown>).deployment, isDeployment);
      return { success: result.success, deployment };
    },
    async reject(id) {
      const result = checked(await post(path(id, "/reject")), success) as { success: boolean; restoredDeploymentId: unknown };
      if (typeof result.restoredDeploymentId !== "string" && result.restoredDeploymentId !== null)
        throw new ApiError("Invalid reject response", 502, result);
      return { success: result.success, restoredDeploymentId: result.restoredDeploymentId };
    },
    async remove(id) {
      const result = checked(await http.request(path(id), { method: "DELETE" }), success) as { success: boolean; message: unknown };
      if (typeof result.message !== "string") throw new ApiError("Invalid delete response", 502, result);
      return { success: result.success, message: result.message };
    },
    restart: (id) => data(path(id, "/restart"), isDeployment, {}),
    async skipPortCheck(id, value) { return checked(await post(path(id, "/skip-port-check"), parseInput(SkipPortCheckSchema, value)), success); },
    async *events(id, options = {}) {
      const { since, signal } = options;
      if (since !== undefined && (!Number.isSafeInteger(since) || since < 0)) throw new TypeError("since must be a nonnegative event cursor");
      const url = http.url(path(id, "/stream"));
      if (since !== undefined) url.searchParams.set("since", String(since));
      yield* http.events(url.href, { signal });
    },
  } satisfies DeploymentResourceOperations);
}
