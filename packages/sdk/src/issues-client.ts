import { IssueCollectionSchemas, IssueJobSchemas, type IssueOperations } from "@repo/contracts";
import type { HttpClient } from "./http";
import { createRemoteScopedOperations } from "./resource-client";

export function createRemoteIssueOperations(http: HttpClient): IssueOperations {
  return Object.freeze({
    ...createRemoteScopedOperations(http, IssueCollectionSchemas, {
      list: { method: "GET", path: () => "/issues", response: value => {
        const body = value as { data?: unknown; counts?: unknown; status?: unknown };
        return { issues: body?.data, counts: body?.counts, status: body?.status };
      } },
      summary: { method: "GET", path: () => "/issues/summary", envelope: "data" },
      health: { method: "GET", path: () => "/issues/health", response: value => {
        const { data, ...rest } = (value ?? {}) as Record<string, unknown>;
        return { ...rest, workloads: data };
      } },
      scanHealth: { method: "POST", path: () => "/issues/health/scan", envelope: "data" },
    }),
    ...createRemoteScopedOperations(http, IssueJobSchemas, {
      rescan: { method: "POST", path: () => "/issues/rescan", envelope: "data" },
      rescanStatus: { method: "GET", path: () => "/issues/rescan/status", envelope: "data" },
    }),
  });
}
