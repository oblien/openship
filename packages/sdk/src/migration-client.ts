import {
  MigrationScopedSchemas,
  MigrationResourceSchemas,
  MigrationRequestSchemas,
  ResourceIdSchema,
  parseInput,
  type MigrationOperations,
} from "@repo/contracts";
import type { HttpClient } from "./http";
import { createRemoteScopedOperations, createRemoteResourceOperations } from "./resource-client";

export function createRemoteMigrationOperations(http: HttpClient): MigrationOperations {
  const run = (id: string) => `/migration/migrations/${encodeURIComponent(id)}`;
  return Object.freeze({
    ...createRemoteScopedOperations(http, MigrationScopedSchemas, {
      listSources: {
        method: "GET",
        path: () => "/migration/sources",
        envelope: "sources",
        redactInvalidResponse: true,
      },
      createSource: {
        method: "POST",
        path: () => "/migration/sources",
        envelope: "server",
        redactInvalidResponse: true,
      },
      testSource: {
        method: "POST",
        path: () => "/migration/sources/test",
        redactInvalidResponse: true,
      },
      scan: {
        method: "POST",
        path: () => "/migration/scan",
        envelope: "stack",
        redactInvalidResponse: true,
      },
      revealEnv: {
        method: "POST",
        path: () => "/migration/reveal-env",
        envelope: "environment",
        redactInvalidResponse: true,
      },
      repoCompose: {
        method: "POST",
        path: () => "/migration/repo-compose",
        envelope: "services",
        redactInvalidResponse: true,
      },
      adopt: { method: "POST", path: () => "/migration/adopt" },
      reimport: { method: "POST", path: () => "/migration/reimport" },
      preview: { method: "POST", path: () => "/migration/preview", envelope: "preview" },
      start: { method: "POST", path: () => "/migration/migrate", redactInvalidResponse: true },
      moveProject: {
        method: "POST",
        path: () => "/migration/project",
        redactInvalidResponse: true,
      },
      active: { method: "GET", path: () => "/migration/active", redactInvalidResponse: true },
      listRuns: {
        method: "GET",
        path: () => "/migration/runs",
        envelope: "runs",
        redactInvalidResponse: true,
      },
    }),
    ...createRemoteResourceOperations(http, MigrationResourceSchemas, {
      removeSource: {
        method: "DELETE",
        path: (id) => `/migration/sources/${encodeURIComponent(id)}`,
      },
      get: { method: "GET", path: run, redactInvalidResponse: true },
      cutover: { method: "POST", path: (id) => `${run(id)}/cutover` },
      cancel: { method: "POST", path: (id) => `${run(id)}/cancel` },
      respond: { method: "POST", path: (id) => `${run(id)}/respond` },
      resume: { method: "POST", path: (id) => `${run(id)}/resume` },
      cleanupTarget: { method: "POST", path: (id) => `${run(id)}/cleanup-target` },
      remove: { method: "DELETE", path: run },
    }),
    events(id, options) {
      return http.events(`${run(parseInput(ResourceIdSchema, id))}/stream`, {
        signal: options?.signal,
      });
    },
    scanEvents(input, options) {
      const parsed = parseInput(MigrationRequestSchemas.scan, input);
      const url = http.url("/migration/scan/stream");
      url.searchParams.set("serverId", parsed.serverId);
      if (parsed.flatDocker) url.searchParams.set("flatDocker", "1");
      return http.events(url.href, { signal: options?.signal });
    },
  } satisfies MigrationOperations);
}
