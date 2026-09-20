import { AnalyticsProjectSchemas, AnalyticsServerSchemas, AnalyticsCollectionSchemas, ResourceIdSchema, parseInput, type AnalyticsOperations } from "@repo/contracts";
import type { HttpClient } from "./http";
import { createRemoteResourceOperations, createRemoteScopedOperations } from "./resource-client";

export function createRemoteAnalyticsOperations(http: HttpClient): AnalyticsOperations {
  const project = (path: string) => (id: string) => `/analytics${path}?projectId=${encodeURIComponent(id)}`;
  const server = (path: string) => (id: string) => `/analytics/server/${encodeURIComponent(id)}${path}`;
  return Object.freeze({
    ...createRemoteResourceOperations(http, AnalyticsProjectSchemas, {
      summary: { method: "GET", path: project(""), envelope: "data" },
      periods: { method: "GET", path: project("/periods"), envelope: "data" },
      overview: { method: "GET", path: project("/overview"), envelope: "data" },
      geo: { method: "GET", path: project("/geo"), envelope: "data" },
      deploymentStats: { method: "GET", path: project("/deployments"), envelope: "data" },
      usage: { method: "GET", path: project("/usage"), envelope: "data" },
      containerInfo: { method: "GET", path: project("/container"), envelope: "data" },
      resources: { method: "GET", path: project("/resources"), envelope: "data" },
      usageHistory: { method: "GET", path: project("/usage/history"), envelope: "data" },
      setPathsCollection: { method: "POST", path: id => `/analytics/paths-collection/${encodeURIComponent(id)}`, envelope: "data" },
    }),
    ...createRemoteResourceOperations(http, AnalyticsServerSchemas, {
      serverBuckets: { method: "GET", path: server(""), envelope: "data" },
      serverGeo: { method: "GET", path: server("/geo"), envelope: "data" },
      serverLive: { method: "GET", path: server("/live"), envelope: "data" },
    }),
    ...createRemoteScopedOperations(http, AnalyticsCollectionSchemas, { dashboard: { method: "GET", path: () => "/analytics/dashboard", envelope: "data" } }),
    async *streamUsage(id, options = {}) { yield* http.events(project("/usage/stream")(parseInput(ResourceIdSchema, id)), { signal: options.signal }); },
  } satisfies AnalyticsOperations);
}
