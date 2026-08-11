import { describe, expect, it } from "vitest";

import { compileRoutingToOblien } from "../src/runtime/oblien-routing";

describe("compileRoutingToOblien", () => {
  it("maps a monorepo config to a static Page + backend workspace proxy", () => {
    const input = compileRoutingToOblien(
      {
        rewrites: [
          { source: "/api/(.*)", destination: "/api/index.js" },
          { source: "/(.*)", destination: "/index.html" },
        ],
      },
      { staticPage: "my-frontend", backend: { workspace: "ws_backend", port: 3000 } },
    );

    expect(input.static).toEqual({ page: "my-frontend" });
    // SPA rewrite is served by the Page (spa default), so only /api proxies.
    expect(input.routes).toEqual([
      {
        match: { path: "/api/", type: "prefix" },
        action: { kind: "proxy", workspace: "ws_backend", port: 3000 },
      },
    ]);
  });

  it("builds a COMPLETE table for the workspace topology (frontend + backend both workspaces)", () => {
    const input = compileRoutingToOblien(
      { rewrites: [{ source: "/api/(.*)", destination: "/api/index.js" }] },
      { root: { workspace: "ws_frontend", port: 8080 }, backend: { workspace: "ws_backend", port: 3000 } },
    );
    expect(input.static).toBeUndefined();
    // /api proxies to the backend; `/` catch-all proxies to the frontend LAST.
    expect(input.routes).toEqual([
      { match: { path: "/api/", type: "prefix" }, action: { kind: "proxy", workspace: "ws_backend", port: 3000 } },
      { match: { path: "/", type: "prefix" }, action: { kind: "proxy", workspace: "ws_frontend", port: 8080 } },
    ]);
  });

  it("builds a server-only table (root workspace backs everything)", () => {
    const input = compileRoutingToOblien({}, { root: { workspace: "ws_api", port: 8080 } });
    expect(input.routes).toEqual([
      { match: { path: "/", type: "prefix" }, action: { kind: "proxy", workspace: "ws_api", port: 8080 } },
    ]);
  });

  it("proxies a full-URL rewrite to a literal origin (not the owned workspace)", () => {
    const input = compileRoutingToOblien(
      { rewrites: [{ source: "/proxy/(.*)", destination: "https://api.example.com/$1" }] },
      { backend: { workspace: "ws_backend", port: 3000 } },
    );
    expect(input.routes).toEqual([
      {
        match: { path: "/proxy/", type: "prefix" },
        action: { kind: "proxy", origin: "https://api.example.com/$1" },
      },
    ]);
  });

  it("compiles redirects BEFORE the catch-all so they aren't shadowed", () => {
    const input = compileRoutingToOblien(
      {
        redirects: [
          { source: "/old", destination: "/new", permanent: true }, // → 308
          { source: "/tmp", destination: "/temp" }, // → 307
          { source: "/see", destination: "/other", statusCode: 303 }, // unsupported → 307
        ],
      },
      { root: { workspace: "ws_app", port: 8080 } },
    );
    expect(input.routes).toEqual([
      { match: { path: "/old", type: "exact" }, action: { kind: "redirect", status: 308, to: "/new" } },
      { match: { path: "/tmp", type: "exact" }, action: { kind: "redirect", status: 307, to: "/temp" } },
      { match: { path: "/see", type: "exact" }, action: { kind: "redirect", status: 307, to: "/other" } },
      { match: { path: "/", type: "prefix" }, action: { kind: "proxy", workspace: "ws_app", port: 8080 } },
    ]);
  });

  it("compiles headers and maps flags (cleanUrls + trailingSlash policy)", () => {
    const enforce = compileRoutingToOblien({
      headers: [{ source: "/(.*)", headers: [{ key: "X-Frame-Options", value: "DENY" }] }],
      cleanUrls: true,
      trailingSlash: true,
    });
    expect(enforce.routes).toEqual([
      {
        match: { path: "/", type: "prefix" },
        action: { kind: "headers", set: [{ key: "X-Frame-Options", value: "DENY" }] },
      },
    ]);
    expect(enforce.cleanUrls).toBe(true);
    expect(enforce.trailingSlash).toBe("enforce");

    const strip = compileRoutingToOblien({ trailingSlash: false });
    expect(strip.trailingSlash).toBe("strip");

    const unset = compileRoutingToOblien({});
    expect(unset.trailingSlash).toBeUndefined();
    expect(unset.cleanUrls).toBeUndefined();
  });

  it("omits static + drops path rewrites for a config with no backend/root", () => {
    const input = compileRoutingToOblien(
      { rewrites: [{ source: "/api/(.*)", destination: "/api/index.js" }] },
      {}, // no static page, no backend, no root
    );
    expect(input.static).toBeUndefined();
    // No backend to proxy to → the rewrite is skipped upstream, no routes emitted.
    expect(input.routes).toEqual([]);
  });

  it("does not emit routes for injection attempts (reuses the shared guards)", () => {
    const input = compileRoutingToOblien(
      {
        rewrites: [{ source: "/evil; } location / { proxy_pass http://x; }", destination: "/api" }],
        redirects: [{ source: "/r", destination: "/y; return 200 'pwned'" }],
      },
      { backend: { workspace: "ws_backend", port: 3000 } },
    );
    expect(input.routes).toEqual([]);
  });
});
