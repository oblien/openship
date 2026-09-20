import {
  ServiceCollectionSchemas,
  ServiceResourceSchemas,
  ResourceIdSchema,
  RuntimeLogsInputSchema,
  parseInput,
  type ServiceOperations,
} from "@repo/contracts";
import type { HttpClient } from "./http";
import {
  createRemoteResourceOperations,
  createRemoteChildResourceOperations,
} from "./resource-client";

const collection = (projectId: string) => `/projects/${encodeURIComponent(projectId)}/services`;
const service = (projectId: string, id: string) =>
  `${collection(projectId)}/${encodeURIComponent(id)}`;

export function createRemoteServiceOperations(http: HttpClient): ServiceOperations {
  return Object.freeze({
    ...createRemoteResourceOperations(http, ServiceCollectionSchemas, {
      list: { method: "GET", path: collection, envelope: "services" },
      create: { method: "POST", path: collection, envelope: "service" },
      sync: { method: "POST", path: (id) => `${collection(id)}/sync`, envelope: "services" },
      activeContainers: {
        method: "GET",
        path: (id) => `${collection(id)}/containers`,
        envelope: "containers",
      },
    }),
    ...createRemoteChildResourceOperations(http, ServiceResourceSchemas, {
      get: { method: "GET", path: service, envelope: "service" },
      update: { method: "PATCH", path: service, envelope: "service" },
      remove: { method: "DELETE", path: service },
      acceptDrift: {
        method: "POST",
        path: (p, id) => `${service(p, id)}/drift/accept`,
        envelope: "service",
      },
      keepDrift: {
        method: "POST",
        path: (p, id) => `${service(p, id)}/drift/keep`,
        envelope: "service",
      },
      listEnvVars: { method: "GET", path: (p, id) => `${service(p, id)}/env`, envelope: "vars" },
      setEnvVars: { method: "PUT", path: (p, id) => `${service(p, id)}/env` },
      revealEnv: {
        method: "POST",
        path: (p, id) => `${service(p, id)}/env-reveal`,
        envelope: "environment",
      },
      volumeSizes: { method: "GET", path: (p, id) => `${service(p, id)}/volume-sizes` },
      start: { method: "POST", path: (p, id) => `${service(p, id)}/start` },
      stop: { method: "POST", path: (p, id) => `${service(p, id)}/stop` },
      restart: {
        method: "POST",
        path: (p, id) => `${service(p, id)}/restart`,
        inputLocation: "query",
      },
      applyEnvironment: { method: "POST", path: (p, id) => `${service(p, id)}/apply-env` },
      runtimeLogs: { method: "GET", path: (p, id) => `${service(p, id)}/logs`, envelope: "data" },
      exec: { method: "POST", path: (p, id) => `${service(p, id)}/exec`, envelope: "data" },
    }),
    async *streamLogs(parent, value, command = {}, options = {}) {
      const projectId = parseInput(ResourceIdSchema, parent);
      const id = parseInput(ResourceIdSchema, value);
      const input = parseInput(RuntimeLogsInputSchema, command);
      const url = http.url(`${service(projectId, id)}/logs/stream`);
      if (input.tail !== undefined) url.searchParams.set("tail", String(input.tail));
      yield* http.events(url.href, { signal: options.signal });
    },
  } satisfies ServiceOperations);
}
