import { ResourceIdSchema, parseInput, ServerCollectionSchemas, ServerResourceSchemas, ServerInstallSessionSchemas,
  InstallServerComponentsInputSchema, ServerInstallSessionInputSchema, ApplyServerContainerInputSchema, ServerContainerInputSchema, type ServerOperations } from "@repo/contracts";
import type { HttpClient } from "./http";
import { createRemoteResourceOperations, createRemoteScopedOperations } from "./resource-client";

export function createRemoteServerOperations(http: HttpClient): ServerOperations {
  const path = (id: string) => `/system/servers/${encodeURIComponent(id)}`;
  const clusterPath = (input?: unknown) => `/system/clusters/${encodeURIComponent((input as { clusterId: string }).clusterId)}`;
  const networkPath = (input?: unknown) => `/system/networks/${encodeURIComponent((input as { networkId: string }).networkId)}`;
  const networkBody = (input?: unknown) => { const { networkId: _id, ...body } = input as Record<string, unknown>; return body; };
  const computePath = (input?: unknown) => `/system/compute-clusters/${encodeURIComponent((input as { clusterId: string }).clusterId)}`;
  const clusterBody = (input?: unknown) => { const { clusterId: _id, ...body } = input as Record<string, unknown>; return body; };
  const tunnelPath = (id: string, input: unknown) => path(id) + `/tunnels/${encodeURIComponent((input as { tunnelId: string }).tunnelId)}`;
  return Object.freeze({
    ...createRemoteScopedOperations(http, ServerCollectionSchemas, {
      networkCapabilities: { method: "GET", path: () => "/system/networks/capabilities" },
      listNetworks: { method: "GET", path: () => "/system/networks" },
      getNetwork: { method: "GET", path: networkPath, inputLocation: "path" },
      createNetwork: { method: "POST", path: () => "/system/networks" },
      updateNetwork: { method: "PATCH", path: networkPath, body: networkBody },
      verifyNetwork: { method: "POST", path: input => networkPath(input) + "/verify", body: networkBody },
      removeNetwork: { method: "DELETE", path: networkPath, body: networkBody },
      listComputeClusters: { method: "GET", path: () => "/system/compute-clusters" },
      getComputeCluster: { method: "GET", path: computePath, inputLocation: "path" },
      createComputeCluster: { method: "POST", path: () => "/system/compute-clusters" },
      updateComputeCluster: { method: "PATCH", path: computePath, body: clusterBody },
      removeComputeCluster: { method: "DELETE", path: computePath, body: clusterBody },
      clusterCapabilities: { method: "GET", path: () => "/system/clusters/capabilities" },
      planManagedNetwork: { method: "POST", path: () => "/system/networks/plans" },
      prepareManagedNetwork: { method: "POST", path: () => "/system/networks/preparations" },
      reviseManagedNetworkAccess: {
        method: "PATCH",
        path: input => `/system/networks/preparations/${encodeURIComponent((input as { preparationId: string }).preparationId)}/connections`,
        body: input => { const { preparationId: _id, ...body } = input as Record<string, unknown>; return body; },
      },
      listManagedNetworkPreparations: { method: "GET", path: () => "/system/networks/preparations" },
      getManagedNetworkPreparation: { method: "GET", path: (input) => `/system/networks/preparations/${encodeURIComponent((input as { preparationId: string }).preparationId)}`, inputLocation: "path" },
      discardManagedNetworkPreparation: {
        method: "DELETE",
        path: input => `/system/networks/preparations/${encodeURIComponent((input as { preparationId: string }).preparationId)}`,
        body: input => { const { preparationId: _id, ...body } = input as Record<string, unknown>; return body; },
      },
      discardManagedNetworkPlan: {
        method: "DELETE",
        path: input => `/system/networks/operations/${encodeURIComponent((input as { operationId: string }).operationId)}`,
        body: input => { const { operationId: _id, ...body } = input as Record<string, unknown>; return body; },
      },
      removeManagedNetworkPreparationMember: {
        method: "DELETE",
        path: input => {
          const { preparationId, serverId } = input as { preparationId: string; serverId: string };
          return `/system/networks/preparations/${encodeURIComponent(preparationId)}/members/${encodeURIComponent(serverId)}`;
        },
        body: input => { const { preparationId: _id, serverId: _server, ...body } = input as Record<string, unknown>; return body; },
      },
      removeManagedNetworkOperationMember: {
        method: "DELETE",
        path: input => {
          const { operationId, serverId } = input as { operationId: string; serverId: string };
          return `/system/networks/operations/${encodeURIComponent(operationId)}/members/${encodeURIComponent(serverId)}`;
        },
        body: input => { const { operationId: _id, serverId: _server, ...body } = input as Record<string, unknown>; return body; },
      },
      getManagedNetworkOperation: {
        method: "GET",
        path: (input) =>
          `/system/networks/operations/${encodeURIComponent((input as { operationId: string }).operationId)}`,
        inputLocation: "path",
      },
      applyManagedNetwork: {
        method: "POST",
        path: (input) =>
          `/system/networks/operations/${encodeURIComponent((input as { operationId: string }).operationId)}/apply`,
        body: (input) => {
          const { operationId: _id, ...body } = input as Record<string, unknown>;
          return body;
        },
      },
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
      infrastructure: { method: "GET", path: id => path(id) + "/infrastructure" },
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
    async *managedNetworkPreparationEvents(value, options = {}) {
      const id = parseInput(ResourceIdSchema, value);
      yield* http.events(`/system/networks/preparations/${encodeURIComponent(id)}/stream`, { signal: options.signal });
    },
    async *managedNetworkOperationEvents(value, options = {}) {
      const id = parseInput(ResourceIdSchema, value);
      yield* http.events(`/system/networks/operations/${encodeURIComponent(id)}/stream`, { signal: options.signal });
    },
    async *clusterEvents(options = {}) {
      yield* http.events("/system/networks/stream", { signal: options.signal });
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
