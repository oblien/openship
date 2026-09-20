import assert from "node:assert/strict";
import { test } from "node:test";
import { moduleHttpSurface } from "./docs-http.mjs";
import { httpSurface } from "./docs-surface.mjs";

const router =
  'const r = secureRouter(new Hono(), { module: "system", basePath: "/api/system", localOnly: true });';
const parse = (body) => moduleHttpSurface("routes.ts", router + "\n" + body);

test("resolves correlated route aliases and shared permission metadata without executing handlers", () => {
  const routes = parse(
    [
      'throw new Error("Never execute route modules");',
      'const read = { tag: "server:read" } as const;',
      'const admin = { ...read, tag: "server:admin" } satisfies Spec;',
      'const aliases = [["/networks", ""], ["/clusters", "network-"]] as const;',
      "for (const [base, prefix] of aliases) {",
      "  const operations = `${base}/${prefix}operations`;",
      '  r.get(operations + "/:id", read, handler);',
      "  r.post(`${base}/${prefix}plans`, { ...admin, body: schema() }, handler);",
      "}",
    ].join("\n"),
  );
  assert.deepEqual(
    routes.map(({ method, path, access }) => ({ method, path, access })),
    [
      { method: "GET", path: "/api/system/networks/operations/:id", access: "server:read" },
      { method: "POST", path: "/api/system/networks/plans", access: "server:admin" },
      { method: "GET", path: "/api/system/clusters/network-operations/:id", access: "server:read" },
      { method: "POST", path: "/api/system/clusters/network-plans", access: "server:admin" },
    ],
  );
  assert.ok(routes.every((route) => route.localOnly && route.module === "system"));
});

test("constant scopes and spread ordering preserve the route's actual permissions", () => {
  const routes = parse(
    [
      'const tag = "server:read";',
      "const spec = { tag };",
      "{",
      '  const tag = "server:admin";',
      '  const path = "/inner";',
      "  r.post(path, { ...spec, tag }, handler);",
      "}",
      'r.get("/outer", { tag: "server:admin", ...spec }, handler);',
      'function unrelated(r) { r.get("/not-a-route"); }',
      'function destructured({ r }) { r.get("/not-a-route"); }',
    ].join("\n"),
  );
  assert.deepEqual(
    routes.map(({ path, access }) => [path, access]),
    [
      ["/api/system/inner", "server:admin"],
      ["/api/system/outer", "server:read"],
    ],
  );
});

test("retains raw multi-method routes, internal access and public handler authentication", () => {
  const routes = moduleHttpSurface(
    "routes.ts",
    [
      "const authRoutes = new Hono();",
      'authRoutes.on(["GET", "POST"], "/*", handler);',
      'const r = secureRouter(new Hono(), { module: "system", basePath: "/api/system" });',
      'r.public("get", "/callback", { reason: "Callback verifies its token" }, handler);',
      'r.get("/internal", { tag: "server:read", localOnly: true }, internalAuth, handler);',
    ].join("\n"),
    new Map([["authRoutes", "/api/auth"]]),
  );
  assert.deepEqual(
    routes.map(({ method, path, access, localOnly }) => ({ method, path, access, localOnly })),
    [
      { method: "GET", path: "/api/auth/*", access: "Handler authentication", localOnly: false },
      { method: "POST", path: "/api/auth/*", access: "Handler authentication", localOnly: false },
      {
        method: "GET",
        path: "/api/system/callback",
        access: "Handler authentication",
        localOnly: false,
      },
      { method: "GET", path: "/api/system/internal", access: "Internal operator", localOnly: true },
    ],
  );
});

test("fails instead of silently omitting or guessing dynamic routes and permissions", () => {
  for (const [body, error] of [
    ['r.get(runtimePath(), { tag: "server:read" }, handler);', /Unresolved route path/],
    [
      'let path = "/mutable"; r.get(path, { tag: "server:read" }, handler);',
      /Unresolved route path/,
    ],
    [
      'for (const path of runtimePaths()) { r.get("/fixed", { tag: "server:read" }, handler); }',
      /Unresolved route loop/,
    ],
    ['r.get("/", { ...runtimeSpec() }, handler);', /Unresolved route permission/],
    [
      'r.get("/", { tag: "server:read", ...runtimeSpec() }, handler);',
      /Unresolved route permission/,
    ],
    [
      'const spec = { tag: "server:read" }; r.get("/", { ...spec, get tag() { return runtimeTag(); } }, handler);',
      /Unresolved route permission/,
    ],
    [
      'r.get("/", { tag: "server:read", localOnly: runtimeFlag() }, handler);',
      /Unresolved route availability/,
    ],
    ['r.public(runtimeMethod(), "/", {}, handler);', /Unresolved route method/],
  ])
    assert.throws(() => parse(body), error);
});

test("the real network inventory includes both generations with their permission tags", () => {
  const routes = httpSurface();
  const find = (method, path) =>
    routes.filter((route) => route.method === method && route.path === path);
  for (const path of [
    "/api/system/networks/operations/:operationId",
    "/api/system/clusters/network-operations/:operationId",
    "/api/system/networks/preparations/:preparationId/stream",
    "/api/system/clusters/network-preparations/:preparationId/stream",
    "/api/system/compute-clusters/:id",
  ]) {
    const matches = find("GET", path);
    assert.equal(matches.length, 1, path);
    assert.equal(matches[0].access, "server:read");
    assert.equal(matches[0].localOnly, true);
  }
  for (const path of ["/api/system/networks/plans", "/api/system/clusters/network-plans"]) {
    const matches = find("POST", path);
    assert.equal(matches.length, 1, path);
    assert.equal(matches[0].access, "server:admin");
  }
  assert.equal(find("GET", "/.well-known/oauth-protected-resource/api/mcp").length, 1);
});
