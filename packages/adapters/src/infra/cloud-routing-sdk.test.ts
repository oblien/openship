import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Oblien } from "oblien";
import { CloudInfraProvider } from "./cloud";
import { managedRoutingFixture } from "../../test/managed-routing-fixture";

const hostname = "app.opsh.io";
let h: ReturnType<typeof managedRoutingFixture>;
let page: Record<string, unknown> | undefined;
let writes: Array<{ method: string; path: string; body: unknown }>;
let requests: URL[];
let provider: CloudInfraProvider;

beforeEach(() => {
  h = managedRoutingFixture();
  page = undefined; writes = []; requests = [];
  // Exercise the SDK's real URL, HTTP methods, and response handling against
  // a simulated provider. Never send a credential or request to a live service.
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== "https://oblien.test") throw new Error("Unexpected network origin");
    requests.push(url);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (method !== "GET") writes.push({ method, path: url.pathname, body });
    if (url.pathname === "/pages/app" && method === "GET")
      return page ? Response.json({ success: true, page }) : Response.json({ error: "Not found" }, { status: 404 });
    if (url.pathname === "/pages" && method === "POST") {
      page = { id: 42, slug: body.slug, domain: body.domain, namespace: h.namespace,
        source_workspace_id: body.workspace_id, exported_path: body.path, url: `https://${hostname}` };
      return Response.json({ success: true, page });
    }
    if (url.pathname === "/pages/app/enable" && method === "POST")
      return Response.json({ success: true });
    if (url.pathname === `/workspace/${h.workspaceId}/network` && method === "GET")
      return Response.json({ ingress_ports: [443] });
    if (url.pathname === `/workspace/${h.workspaceId}/network` && method === "PATCH")
      return Response.json({ success: true });
    if (url.pathname === `/domain/routes/${hostname}` && method === "PUT")
      return Response.json({ success: true, hostname, version: writes.length,
        config: { v: 1, rules: [{ action: { k: "proxy", backend: "http://10.0.0.9:3000", vm: h.workspaceId } }] } });
    throw new Error(`Unexpected provider request: ${method} ${url.pathname}`);
  }));
  provider = new CloudInfraProvider(new Oblien({ token: "test-namespace-token", baseUrl: "https://oblien.test" }),
    { namespace: h.namespace, scope: h.scope });
});
afterEach(() => vi.unstubAllGlobals());

it("reuses the owned Page through the SDK after routes become a compiled table", async () => {
  for (let i = 0; i < 2; i++)
    await provider.registerRoute({ domain: hostname, targetUrl: "http://127.0.0.1:3000", tls: true });
  expect(writes.filter(request => request.path === "/pages")).toHaveLength(1);
  const routes = writes.filter(request => request.path === `/domain/routes/${hostname}`);
  expect(routes).toHaveLength(2);
  expect(routes[1]).toEqual({ method: "PUT", path: `/domain/routes/${hostname}`, body: {
    routes: [{ match: { path: "/", type: "prefix" }, action: { kind: "proxy", workspace: h.workspaceId, port: 3000 } }],
  } });
  expect(writes).toContainEqual({ method: "PATCH", path: `/workspace/${h.workspaceId}/network`, body: { ingress_ports: [443, 3000] } });
  expect(requests.some(url => url.pathname === "/workspace")).toBe(false);
});

it.each(["namespace", "source_workspace_id", "exported_path"])("does not write when the Page's %s changes", async field => {
  await provider.registerRoute({ domain: hostname, targetUrl: "http://127.0.0.1:3000", tls: true });
  page![field] = "different-owner";
  writes.length = 0;
  await expect(provider.registerRoute({ domain: hostname, targetUrl: "http://127.0.0.1:3000", tls: true })).rejects.toThrow("not owned");
  expect(writes).toEqual([]);
});
