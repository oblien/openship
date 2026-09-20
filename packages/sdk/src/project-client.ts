import {
  CreateProjectBody,
  EnsureProjectBody,
  UpdateProjectBody,
  ResourceIdSchema,
  ListProjectsSchema,
  ProjectControlSchemas,
  ScanLocalProjectBody,
  ImportLocalProjectBody,
  isLocalProjectScan,
  isLocalProjects,
  parseInput,
  isRecord,
  isProject,
  isProjectPage,
  isProjectHome,
  RuntimeLogsInputSchema,
  ServerLogsInputSchema,
  isEnsureProjectResult,
  type ProjectOperations,
} from "@repo/contracts";
import { ApiError } from "./errors";
import type { HttpClient } from "./http";
import { createRemoteResourceOperations } from "./resource-client";

export function createRemoteProjectOperations(http: HttpClient): ProjectOperations {
  const path = (id: string) => "/projects/" + encodeURIComponent(parseInput(ResourceIdSchema, id));
  function checked<T>(value: unknown, guard: (value: unknown) => value is T): T {
    if (!guard(value)) throw new ApiError("Invalid project response", 502, value);
    return value;
  }
  async function data(url: string, method = "GET", body?: unknown) {
    const response = await http.request(url, {
      method,
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    return checked(isRecord(response) ? response.data : undefined, isProject);
  }
  return Object.freeze({
    ...createRemoteResourceOperations(http, ProjectControlSchemas, {
      getAppSettings: { method: "GET", path: id => path(id) + "/app-settings", envelope: "data" },
      updateAppSettings: { method: "PATCH", path: id => path(id) + "/app-settings", envelope: "data" },
      getAppConnection: { method: "GET", path: id => path(id) + "/app-connection", envelope: "data" },
      transferToCloud: { method: "POST", path: id => path(id) + "/transfer/to-cloud", body: () => ({}) },
      transferToSelfHosted: { method: "POST", path: id => path(id) + "/transfer/to-self-hosted", body: () => ({}) },
      getServerLogStreamToken: { method: "GET", path: id => path(id) + "/server-logs/stream-token" },
      recentServerLogs: { method: "GET", path: id => path(id) + "/server-logs/recent" },
      listRouteRules: { method: "GET", path: id => path(id) + "/route-rules", envelope: "rules" },
      createRouteRule: { method: "POST", path: id => path(id) + "/route-rules", envelope: "rule" },
      updateRouteRule: {
        method: "PATCH", path: (id, input) => `${path(id)}/route-rules/${encodeURIComponent((input as { ruleId: string }).ruleId)}`,
        body: (_id, input) => { const { ruleId: _, ...patch } = input as Record<string, unknown>; return patch; }, envelope: "rule",
      },
      removeRouteRule: { method: "DELETE", path: (id, input) => `${path(id)}/route-rules/${encodeURIComponent(input as string)}`, inputLocation: "path" },
      getIncidents: { method: "GET", path: id => path(id) + "/incidents" },
      connectDomain: { method: "POST", path: id => path(id) + "/connect" },
      listConnections: { method: "GET", path: id => path(id) + "/connections", envelope: "data" },
      listConnectionCandidates: { method: "GET", path: id => path(id) + "/connections/candidates", envelope: "data" },
      listConnectionConsumers: { method: "GET", path: id => path(id) + "/connections/consumers", envelope: "data" },
      createConnection: { method: "POST", path: id => path(id) + "/connections", envelope: "data" },
      connectBundle: { method: "POST", path: id => path(id) + "/connections/bundle", envelope: "data" },
      removeConnection: { method: "DELETE", path: (id, input) => path(id) + "/connections/" + encodeURIComponent(String(input)), inputLocation: "path", envelope: "data" },
      getStorage: { method: "GET", path: id => path(id) + "/storage", envelope: "data" },
      bindStorage: { method: "POST", path: id => path(id) + "/storage", envelope: "data" },
      unbindStorage: { method: "DELETE", path: id => path(id) + "/storage", envelope: "data" },
      getEdgeConfig: { method: "GET", path: id => path(id) + "/edge-config" },
      remove: { method: "DELETE", path },
      getInfo: { method: "GET", path: (id) => path(id) + "/info", envelope: "data" },
      getGitInfo: { method: "GET", path: (id) => path(id) + "/git" },
      listBranches: { method: "GET", path: (id) => path(id) + "/branches" },
      linkRepo: { method: "POST", path: (id) => path(id) + "/git/link" },
      setReleaseImageSource: {
        method: "PUT",
        path: (id) => path(id) + "/release-image-source",
        envelope: "data",
      },
      setAutoDeploy: { method: "POST", path: (id) => path(id) + "/auto-deploy" },
      setWebhookDomain: { method: "POST", path: (id) => path(id) + "/webhook-domain" },
      listDeployments: { method: "GET", path: (id) => path(id) + "/deployments" },
      deploymentSession: { method: "POST", path: (id) => path(id) + "/deployment-session" },
      clearBuildCache: { method: "POST", path: (id) => path(id) + "/clear-build" },
      getRollbackCapacity: {
        method: "GET",
        path: (id) => path(id) + "/rollback-capacity",
        envelope: "data",
      },
      checkPorts: { method: "POST", path: (id) => path(id) + "/port-check", envelope: "data" },
      checkOutput: { method: "POST", path: (id) => path(id) + "/output-check", envelope: "data" },
      getPendingActions: {
        method: "GET",
        path: (id) => path(id) + "/pending-actions",
        envelope: "data",
      },
      getCommitStatus: {
        method: "GET",
        path: (id) => path(id) + "/commit-status",
        envelope: "data",
      },
      listEnvironments: {
        method: "GET",
        path: (id) => path(id) + "/environments",
        envelope: "data",
      },
      createEnvironment: {
        method: "POST",
        path: (id) => path(id) + "/environments",
        envelope: "data",
      },
      listEnvVars: { method: "GET", path: (id) => path(id) + "/env", envelope: "data" },
      mergeEnvVars: { method: "PATCH", path: (id) => path(id) + "/env" },
      getResources: { method: "GET", path: (id) => path(id) + "/resources", envelope: "data" },
      updateResources: { method: "PATCH", path: (id) => path(id) + "/resources", envelope: "data" },
      setSleepMode: { method: "POST", path: (id) => path(id) + "/sleep-mode" },
      setOptions: { method: "POST", path: (id) => path(id) + "/options", envelope: "data" },
      setBranch: { method: "POST", path: (id) => path(id) + "/branch" },
      enable: { method: "POST", path: (id) => path(id) + "/enable" },
      disable: { method: "POST", path: (id) => path(id) + "/disable" },
      retryRouting: { method: "POST", path: (id) => path(id) + "/routing/retry" },
      runtimeLogs: { method: "GET", path: (id) => path(id) + "/logs", envelope: "data" },
      getCloneToken: { method: "GET", path: (id) => path(id) + "/clone-token" },
      updateCloneToken: { method: "PATCH", path: (id) => path(id) + "/clone-token" },
      deletionPreview: {
        method: "GET",
        path: (id) => path(id) + "/deletion-preview",
        envelope: "preview",
      },
    }),
    async getHome() { return checked(await http.request("/projects/home"), isProjectHome); },
    async *streamRuntimeLogs(id, command = {}, options = {}) {
      const input = parseInput(RuntimeLogsInputSchema, command);
      const url = http.url(path(id) + "/logs/stream");
      if (input.tail !== undefined) url.searchParams.set("tail", String(input.tail));
      yield* http.events(url.href, { signal: options.signal });
    },
    async *streamServerLogs(id, command = {}, options = {}) {
      const input = parseInput(ServerLogsInputSchema, command);
      const url = http.url(path(id) + "/server-logs/stream");
      if (input.domain !== undefined) url.searchParams.set("domain", input.domain);
      yield* http.events(url.href, { signal: options.signal });
    },
    create: async (input) => data("/projects", "POST", parseInput(CreateProjectBody, input)),
    importLocal: async input => data("/projects/import", "POST", parseInput(ImportLocalProjectBody, input)),
    async scanLocal(input) {
      return checked(await http.request("/projects/scan", { method: "POST", body: JSON.stringify(parseInput(ScanLocalProjectBody, input)) }), isLocalProjectScan);
    },
    async listLocal() { return checked(await http.request("/projects/local"), isLocalProjects); },
    get: async (id) => data(path(id)),
    update: async (id, input) => data(path(id), "PATCH", parseInput(UpdateProjectBody, input)),
    async ensure(input) {
      return checked(
        await http.request("/projects/ensure", {
          method: "POST",
          body: JSON.stringify(parseInput(EnsureProjectBody, input)),
        }),
        isEnsureProjectResult,
      );
    },
    async list(input = {}) {
      const query = parseInput(ListProjectsSchema, input),
        url = http.url("/projects");
      for (const [key, value] of Object.entries(query))
        if (value !== undefined) url.searchParams.set(key, String(value));
      return checked(await http.request(url.href), isProjectPage);
    },
  } satisfies ProjectOperations);
}
