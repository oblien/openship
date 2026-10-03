import { vi, type Mock } from "vitest";
import type { Oblien } from "oblien";
import type { CommandExecutor } from "../src/types";
import { CloudInfraProvider, type CloudProjectRoutingScope } from "../src/infra/cloud";
import { cloudDockerProjectPaths } from "../src/runtime/cloud/docker-paths";

/** Provider state for managed-route tests. All requests remain in memory. */
export function managedRoutingFixture(): {
  namespace: string; workspaceId: string; projectId: string;
  paths: ReturnType<typeof cloudDockerProjectPaths>;
  records: Map<string, Record<string, any>>;
  pages: Record<"list" | "get" | "create" | "deploy" | "enable" | "disable" | "delete" | "connectDomain" | "getDomain" | "renewSSL", Mock>;
  executor: Record<"exec" | "writeFile" | "rm", Mock>;
  scope: CloudProjectRoutingScope;
  workspace: { network: Record<"get" | "update", Mock> };
  routes: { set: Mock }; domain: { routes: Mock };
  client: Oblien; infra: CloudInfraProvider;
} {
  const namespace = "tenant-one", workspaceId = "workspace-one", projectId = "project-one";
  const paths = cloudDockerProjectPaths(projectId);
  const records = new Map<string, Record<string, any>>();
  const pages = {
    list: vi.fn(async () => ({ pages: [...records.values()] })),
    get: vi.fn(async (slug: string) => {
      if (!records.has(slug)) throw Object.assign(new Error("missing Page"), { status: 404 });
      return { page: records.get(slug)! };
    }),
    create: vi.fn(async (input: { slug: string; domain: string; path: string; workspace_id: string }) => {
      const page = { id: records.size + 1, slug: input.slug, domain: input.domain, namespace, source_workspace_id: input.workspace_id, exported_path: input.path, url: `https://${input.slug}.${input.domain}` };
      records.set(input.slug, page); return { success: true, page };
    }),
    deploy: vi.fn(async () => ({ success: true })),
    enable: vi.fn(async () => ({ success: true })),
    disable: vi.fn(async () => ({ success: true })),
    delete: vi.fn(async (slug: string) => { records.delete(slug); return { success: true }; }),
    connectDomain: vi.fn(async (slug: string, input: { domain: string }) => { records.get(slug)!.custom_domain = input.domain; return { success: true }; }),
    getDomain: vi.fn(async (slug: string) => ({ domain: { domain: records.get(slug)?.custom_domain, ssl: { status: "active", expiresAt: "2099-01-01T00:00:00Z" } } })),
    renewSSL: vi.fn(async () => ({ success: true })),
  };
  const executor = { exec: vi.fn(async (command: string) => command.startsWith("readlink -f -- ") ? command.match(/'([^']+)'/)![1] : ""), writeFile: vi.fn(), rm: vi.fn() };
  const scope: CloudProjectRoutingScope = {
    workspaceId, projectId, routeRoot: paths.routes, staticReleaseRoot: `${paths.bare}/releases`, executor: executor as unknown as CommandExecutor,
    lock: { run: work => work() },
    resolveTarget: vi.fn(async (_id, port) => { if (port !== 3000) throw new Error("unowned port"); return port; }),
    resolveUrl: vi.fn(async url => { if (url !== "http://127.0.0.1:3000") throw new Error("unowned or invalid upstream"); return 3000; }),
  };
  const workspace = { network: { get: vi.fn(async () => ({ ingress_ports: [443] })), update: vi.fn(async () => ({ success: true })) } };
  const routes = { set: vi.fn(async () => ({ success: true })) };
  const domain = { routes: vi.fn(async () => ({ data: [...records.values()].flatMap(page => [
    { hostname: `${page.slug}.${page.domain}`, namespace: page.namespace, owner_type: "page", owner_id: page.id, is_custom: false },
    ...(page.custom_domain ? [{ hostname: page.custom_domain, namespace: page.namespace, owner_type: "page", owner_id: page.id, is_custom: true }] : []),
  ]) })) };
  const client = { pages, routes, domain, workspace: vi.fn(() => workspace) } as unknown as Oblien;
  const infra = new CloudInfraProvider(client, { namespace, scope });
  return { namespace, workspaceId, projectId, paths, records, pages, executor, scope, workspace, routes, domain, client, infra };
}
