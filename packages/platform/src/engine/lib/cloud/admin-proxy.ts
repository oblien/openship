import type { CloudAdminProxy } from "@repo/adapters";
import { cloudClient } from "./client";
import { cloudRequestError } from "./request-error";

/** Admin-only provider operations remain on the SaaS, including Pages reads. */
export function createRemoteCloudAdmin(organizationId: string): CloudAdminProxy {
  const client = cloudClient({ organizationId });
  async function request<T>(path: string, body?: unknown): Promise<T> {
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
    createPage: (input) => pages.create(input),
    enablePage: async (slug) => { await pages.enable(slug); },
    disablePage: async (slug) => { await pages.disable(slug); },
    deletePage: async (slug) => { await pages.delete(slug); },
    domainRoutes: () => request("/api/cloud/route-registry"),
    setRoutes: (hostname, input) => request("/api/cloud/resource-proxy", { operation: "setRoutes", hostname, input }),
  };
}
