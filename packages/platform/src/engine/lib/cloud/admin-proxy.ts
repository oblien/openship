import type { CloudAdminProxy } from "@repo/adapters";
import { cloudClient } from "./client";
import { cloudRequestError } from "./request-error";
import { requireLinkedCloudServer, remoteCloudRequest } from "./server-link";

/** Admin-only provider operations remain on the SaaS, including Pages reads. */
export function createRemoteCloudAdmin(organizationId: string, workspaceId?: string): CloudAdminProxy {
  const client = cloudClient({ organizationId });
  async function request<T>(path: string, body?: unknown): Promise<T> {
    if (workspaceId) {
      const { remote } = await requireLinkedCloudServer(organizationId, workspaceId);
      return remoteCloudRequest<T>(organizationId, `${path}?serverId=${encodeURIComponent(remote.serverId)}`,
        body === undefined ? undefined : { method: "POST", body: JSON.stringify(body) }, remote);
    }
    const response = await client.request(path, body === undefined ? undefined : {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    if (!response) throw new Error("Connect Openship Cloud before managing cloud resources");
    if (!response.ok) throw await cloudRequestError(response, "Cloud resource operation");
    return await response.json() as T;
  }
  type Pages = NonNullable<CloudAdminProxy["pages"]>;
  function pageCall<K extends keyof Pages>(operation: K, input: object): Promise<Awaited<ReturnType<Pages[K]>>> {
    return request("/api/cloud/resource-proxy", { operation, ...input });
  }
  const pages: Pages = {
    list: () => pageCall("list", {}),
    get: (slug) => pageCall("get", { slug }),
    create: ({ namespace: _namespace, ...input }) => pageCall("create", { input }),
    deploy: (slug, input) => pageCall("deploy", { slug, input }),
    enable: (slug) => pageCall("enable", { slug }),
    disable: (slug) => pageCall("disable", { slug }),
    delete: (slug) => pageCall("delete", { slug }),
    getDomain: (slug) => pageCall("getDomain", { slug }),
    connectDomain: (slug, input) => pageCall("connectDomain", { slug, input }),
    disconnectDomain: (slug) => pageCall("disconnectDomain", { slug }),
    checkDNS: (slug, input) => pageCall("checkDNS", { slug, input }),
    renewSSL: (slug) => pageCall("renewSSL", { slug }),
  };
  return {
    pages,
    domainRoutes: () => request("/api/cloud/route-registry"),
    setRoutes: (hostname, input) => request("/api/cloud/resource-proxy", { operation: "setRoutes", hostname, input }),
  };
}
