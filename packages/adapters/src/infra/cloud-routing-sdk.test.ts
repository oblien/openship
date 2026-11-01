import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Oblien } from "oblien";
import { AppError } from "@repo/core";
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

it.each([301, 302, 307, 308])("sends canonical redirect intent through the real SDK and removes it for Serve both (%s)", async statusCode => {
  await provider.registerRoute({ domain: hostname, targetUrl: "http://127.0.0.1:3000", tls: true,
    redirectHost: { target: "primary.example.com", statusCode } });
  expect(writes).toContainEqual({ method: "PUT", path: `/domain/routes/${hostname}`, body: {
    routes: [{ match: { path: "/(.*)", type: "wildcard" }, action: { kind: "redirect", status: statusCode, to: "https://primary.example.com/$1" } }],
  } });
  await provider.registerRoute({ domain: hostname, targetUrl: "http://127.0.0.1:3000", tls: true });
  const tables = writes.filter(request => request.path === `/domain/routes/${hostname}`);
  expect(tables.at(-1)?.body).toEqual({ routes: [{ match: { path: "/", type: "prefix" }, action: { kind: "proxy", workspace: h.workspaceId, port: 3000 } }] });
  expect(writes.filter(request => request.path === "/pages")).toHaveLength(1);
  expect(requests.some(url => url.pathname === "/workspace")).toBe(false);
});

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

it("publishes path-only routes through the SDK without a static or SPA fallback", async () => {
  await provider.registerRoute({
    domain: hostname,
    tls: true,
    notFound: true,
    proxyLocations: [{ pathPrefix: "/api/", targetUrl: "http://127.0.0.1:3000" }],
  });
  expect(writes).toContainEqual({
    method: "PUT", path: `/domain/routes/${hostname}`, body: {
      spa: false,
      routes: [{
        match: { path: "/api/", type: "prefix" },
        action: { kind: "proxy", workspace: h.workspaceId, port: 3000 },
      }],
    },
  });
});

// Both relay transports must preserve provider failures without treating
// ownership failures or a missing API endpoint as an absent provider Page.
const relayFailure = (transport: "linked" | "unscoped", status: number, code?: string) =>
  transport === "linked"
    ? new AppError("Cloud resource operation failed", status, code)
    : Object.assign(new Error("Cloud resource operation failed"), {
      name: "CloudRequestError", status, ...(code ? { code } : {}),
    });

it.each([
  ["linked", "missing"], ["linked", "create-conflict"],
  ["unscoped", "missing"], ["unscoped", "create-conflict"],
] as const)("recovers a missing route anchor through %s Cloud RPC (%s)", async (transport, outcome) => {
  const client = new Oblien({ token: "test-namespace-token", baseUrl: "https://oblien.test" });
  const pages = new Proxy(client.pages, {
    get(target, key) {
      if (key === "get") return async (slug: string) => {
        try { return await target.get(slug); }
        catch { throw relayFailure(transport, 404, "CLOUD_PROVIDER_ERROR"); }
      };
      if (key === "create") return async (input: Parameters<typeof target.create>[0]) => {
        const result = await target.create(input);
        // Another publisher won creation; the owned Page can still be reused.
        if (outcome === "create-conflict") throw relayFailure(transport, 409, "CLOUD_PROVIDER_ERROR");
        return result;
      };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  provider = new CloudInfraProvider(client, { namespace: h.namespace, scope: h.scope, adminProxy: { pages } });
  await provider.registerRoute({ domain: hostname, targetUrl: "http://127.0.0.1:3000", tls: true });
  expect(writes.filter(request => request.path === "/pages")).toHaveLength(1);
  expect(writes.filter(request => request.path === `/domain/routes/${hostname}`)).toHaveLength(1);
  await provider.registerRoute({ domain: hostname, targetUrl: "http://127.0.0.1:3000", tls: true });
  expect(writes.filter(request => request.path === "/pages")).toHaveLength(1);
});

it.each([
  ["linked", "CLOUD_RESOURCE_NOT_FOUND"], ["linked", "SERVER_NOT_FOUND"],
  ["linked", "CLOUD_SERVER_REQUEST_FAILED"], ["unscoped", "CLOUD_RESOURCE_NOT_FOUND"],
  ["unscoped", "SERVER_NOT_FOUND"], ["unscoped", "CLOUD_SERVER_REQUEST_FAILED"],
  ["unscoped", undefined],
] as const)("does not turn an ownership or endpoint 404 into a new Page (%s, %s)", async (transport, code) => {
  const client = new Oblien({ token: "test-namespace-token", baseUrl: "https://oblien.test" });
  const failure = relayFailure(transport, 404, code);
  const pages = new Proxy(client.pages, { get(target, key) {
    if (key === "get") return async () => { throw failure; };
    const value = Reflect.get(target, key);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  provider = new CloudInfraProvider(client, { namespace: h.namespace, scope: h.scope, adminProxy: { pages } });
  await expect(provider.registerRoute({ domain: hostname, targetUrl: "http://127.0.0.1:3000", tls: true })).rejects.toBe(failure);
  expect(writes).toEqual([]);
  expect(h.scope.executor.writeFile).not.toHaveBeenCalled();
});
