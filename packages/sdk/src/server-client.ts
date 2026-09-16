import { ResourceIdSchema, parseInput, ServerCollectionSchemas, ServerResourceSchemas, ServerInstallSessionSchemas,
  InstallServerComponentsInputSchema, ServerInstallSessionInputSchema, ApplyServerContainerInputSchema, ServerContainerInputSchema, type ServerOperations } from "@repo/contracts";
import type { HttpClient } from "./http";
import { createRemoteResourceOperations, createRemoteScopedOperations } from "./resource-client";

export function createRemoteServerOperations(http: HttpClient): ServerOperations {
  const path = (id: string) => `/system/servers/${encodeURIComponent(id)}`;
  const clusterPath = (input?: unknown) => `/system/clusters/${encodeURIComponent((input as { clusterId: string }).clusterId)}`;
  const clusterBody = (input?: unknown) => { const { clusterId: _id, ...body } = input as Record<string, unknown>; return body; };
  const tunnelPath = (id: string, input: unknown) => path(id) + `/tunnels/${encodeURIComponent((input as { tunnelId: string }).tunnelId)}`;
  return Object.freeze({
    ...createRemoteScopedOperations(http, ServerCollectionSchemas, {
      clusterCapabilities: { method: "GET", path: () => "/system/clusters/capabilities" },
      listClusters: { method: "GET", path: () => "/system/clusters" },
      getCluster: { method: "GET", path: clusterPath, inputLocation: "path" },
      createCluster: { method: "POST", path: () => "/system/clusters" },
      updateCluster: { method: "PATCH", path: clusterPath, body: clusterBody },
      verifyCluster: { method: "POST", path: input => clusterPath(input) + "/verify", body: clusterBody },
      removeCluster: { method: "DELETE", path: clusterPath, body: clusterBody },
      listAllContainers: { method: "GET", path: () => "/system/containers" },
      scanAllContainers: { method: "POST", path: () => "/system/containers/scan" },
      containersBehind: { method: "GET", path: () => "/system/containers/behind" },
      containerIssues: { method: "GET", path: () => "/system/containers/issues" },
      applyingContainers: { method: "GET", path: () => "/system/containers/applying" },
      applyAllContainers: { method: "POST", path: () => "/system/containers/apply-all" },
      list: { method: "GET", path: () => "/system/servers" },
      create: { method: "POST", path: () => "/system/servers" },
      testConnection: { method: "POST", path: () => "/system/test-connection", resultStatuses: [400, 502] },
    }),
    ...createRemoteResourceOperations(http, ServerResourceSchemas, {
      inspectNetwork: { method: "POST", path: id => path(id) + "/network/inspect" },
      githubStatus: { method: "GET", path: id => `/system/servers/${encodeURIComponent(id)}/github` },
      connectGitHub: { method: "POST", path: id => `/system/servers/${encodeURIComponent(id)}/github/connect` },
      pollGitHubConnection: { method: "GET", path: id => `/system/servers/${encodeURIComponent(id)}/github/connect/poll`, envelope: "data" },
      setGitHubToken: { method: "PUT", path: id => `/system/servers/${encodeURIComponent(id)}/github/token` },
      generateGitHubKey: { method: "POST", path: id => `/system/servers/${encodeURIComponent(id)}/github/ssh-key` },
      useGitHubDeployKeys: { method: "PUT", path: id => `/system/servers/${encodeURIComponent(id)}/github/deploy-key-mode` },
      disconnectGitHub: { method: "DELETE", path: id => `/system/servers/${encodeURIComponent(id)}/github` },
      listTunnels: { method: "GET", path: id => path(id) + "/tunnels" },
      saveTunnel: { method: "POST", path: id => path(id) + "/tunnels" },
      startTunnel: { method: "POST", inputLocation: "path", path: (id, input) => tunnelPath(id, input) + "/start" },
      stopTunnel: { method: "POST", inputLocation: "path", path: (id, input) => tunnelPath(id, input) + "/stop" },
      removeTunnel: { method: "DELETE", inputLocation: "path", path: tunnelPath },
      listContainers: { method: "GET", path: id => path(id) + "/containers" },
      scanContainers: { method: "POST", path: id => path(id) + "/containers/scan" },
      containerApplySession: { method: "GET", inputLocation: "path", path: (id, input) => path(id) + `/containers/${encodeURIComponent((input as { component: string }).component)}/apply/session` },
      get: { method: "GET", path },
      reachability: { method: "GET", path: id => path(id) + "/reachability" },
      update: { method: "PATCH", path },
      deletionPreview: { method: "GET", path: id => path(id) + "/deletion-preview" },
      remove: { method: "DELETE", path, inputLocation: "query", resultStatuses: [409] },
      exec: { method: "POST", path: id => path(id) + "/exec", envelope: "data" },
      listModules: { method: "GET", path: id => path(id) + "/modules" },
      scanModules: { method: "POST", path: id => path(id) + "/modules/scan" },
      applyModule: { method: "POST", inputLocation: "path", path: (id, input) => path(id) + `/modules/${encodeURIComponent((input as { module: string }).module)}/apply` },
      getRateLimit: { method: "GET", path: id => path(id) + "/rate-limit" },
      updateRateLimit: { method: "PATCH", path: id => path(id) + "/rate-limit" },
      check: { method: "POST", path: () => "/system/check", body: (serverId, input) => ({ ...(input as object), serverId }) },
      installComponent: { method: "POST", path: () => "/system/install", body: (serverId, input) => ({ ...(input as object), serverId }) },
      removeComponent: { method: "POST", path: () => "/system/remove", body: (serverId, input) => ({ ...(input as object), serverId }) },
      scanPorts: { method: "POST", path: id => path(id) + "/ports/scan" },
    }),
    ...createRemoteScopedOperations(http, ServerInstallSessionSchemas, {
      getInstallSession: { method: "GET", inputLocation: "path", path: input => {
        const { sessionId } = input as { sessionId?: string };
        return "/system/install/session" + (sessionId ? `?id=${encodeURIComponent(sessionId)}` : "");
      } },
      respondToInstall: { method: "POST", path: () => "/system/install/respond" },
    }),
    async *applyContainer(value, command, options = {}) {
      const id = parseInput(ResourceIdSchema, value);
      const input = parseInput(ApplyServerContainerInputSchema, command);
      yield* http.events(path(id) + `/containers/${input.component}/apply/stream?intent=${input.intent ?? "update"}`, { method: "POST", signal: options.signal });
    },
    async *containerApplyEvents(value, command, options = {}) {
      const id = parseInput(ResourceIdSchema, value);
      const input = parseInput(ServerContainerInputSchema, command);
      yield* http.events(path(id) + `/containers/${input.component}/apply/stream`, { signal: options.signal });
    },
    async *installComponents(value, command, options = {}) {
      const serverId = parseInput(ResourceIdSchema, value);
      const input = parseInput(InstallServerComponentsInputSchema, command);
      yield* http.events("/system/install/stream", { method: "POST", body: JSON.stringify({ ...input, serverId }), signal: options.signal });
    },
    async *installEvents(command = {}, options = {}) {
      const input = parseInput(ServerInstallSessionInputSchema, command);
      yield* http.events("/system/install/stream" + (input.sessionId ? `?id=${encodeURIComponent(input.sessionId)}` : ""), { signal: options.signal });
    },
    async *monitor(value, options = {}) {
      const id = parseInput(ResourceIdSchema, value);
      yield* http.events(`/system/monitor/stream?serverId=${encodeURIComponent(id)}`, { signal: options.signal });
    },
  } satisfies ServerOperations);
}
