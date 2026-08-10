import { describe, it, expect } from "vitest";
import type { ImportedSite } from "../types";
import { buildProxyRouteIndex } from "./api";

const proxySite = (over: Partial<ImportedSite> & { url: string }): ImportedSite => ({
  serverNames: over.serverNames ?? ["app.example.com"],
  ssl: over.ssl ?? false,
  target: { kind: "proxy", url: over.url },
  routes: over.routes,
  tls: over.tls,
  source: over.source,
});

/** Grab the single route indexed at a port (each port now maps to a LIST). */
const one = (idx: Map<number, ReturnType<typeof buildProxyRouteIndex> extends Map<number, infer V> ? V : never>, port: number) => {
  const list = idx.get(port);
  expect(list?.length).toBe(1);
  return list![0];
};

describe("buildProxyRouteIndex", () => {
  it("maps a proxied vhost to its upstream host port with path + domains + ssl + cert", () => {
    const idx = buildProxyRouteIndex([
      proxySite({
        url: "http://127.0.0.1:3000",
        serverNames: ["app.example.com"],
        ssl: true,
        tls: { certPath: "/etc/letsencrypt/live/app/fullchain.pem", keyPath: "/etc/letsencrypt/live/app/privkey.pem" },
        source: "/etc/nginx/sites-enabled/app",
      }),
    ]);
    expect(idx.get(3000)).toEqual([
      {
        port: 3000,
        path: "/",
        domains: ["app.example.com"],
        ssl: {
          enabled: true,
          certPath: "/etc/letsencrypt/live/app/fullchain.pem",
          keyPath: "/etc/letsencrypt/live/app/privkey.pem",
        },
        source: "/etc/nginx/sites-enabled/app",
      },
    ]);
  });

  it("indexes a path-fan-out vhost as one entry PER (port,path) so /v3 → :1020 is kept", () => {
    // api.onvo.me: `/` → :1010, `/v3` → :1020 (the real bug that dropped /v3).
    const idx = buildProxyRouteIndex([
      proxySite({
        url: "http://localhost:1010",
        serverNames: ["api.onvo.me"],
        ssl: true,
        routes: [
          { path: "/", url: "http://localhost:1010" },
          { path: "/v3", url: "http://localhost:1020" },
        ],
      }),
    ]);
    expect(idx.get(1010)).toEqual([
      { port: 1010, path: "/", domains: ["api.onvo.me"], ssl: { enabled: true, certPath: undefined, keyPath: undefined } },
    ]);
    expect(idx.get(1020)).toEqual([
      { port: 1020, path: "/v3", domains: ["api.onvo.me"], ssl: { enabled: true, certPath: undefined, keyPath: undefined } },
    ]);
  });

  it("skips static docroots (no upstream port)", () => {
    const idx = buildProxyRouteIndex([
      { serverNames: ["static.example.com"], ssl: true, target: { kind: "static", root: "/var/www" } },
    ]);
    expect(idx.size).toBe(0);
  });

  it("skips malformed upstream URLs", () => {
    expect(buildProxyRouteIndex([proxySite({ url: "not-a-url" })]).size).toBe(0);
    expect(buildProxyRouteIndex([proxySite({ url: "http://127.0.0.1/" })]).size).toBe(0); // no port
  });

  it("unions domains for two vhosts on the same upstream port + keeps the SSL one's cert", () => {
    const idx = buildProxyRouteIndex([
      proxySite({ url: "http://127.0.0.1:8080", serverNames: ["a.example.com"], ssl: false }),
      proxySite({
        url: "http://127.0.0.1:8080",
        serverNames: ["b.example.com"],
        ssl: true,
        tls: { certPath: "/c/fullchain.pem", keyPath: "/c/privkey.pem" },
      }),
    ]);
    const route = one(idx, 8080);
    expect(route.domains.sort()).toEqual(["a.example.com", "b.example.com"]);
    expect(route.ssl).toEqual({ enabled: true, certPath: "/c/fullchain.pem", keyPath: "/c/privkey.pem" });
  });

  it("reports ssl disabled when no TLS on the vhost", () => {
    const idx = buildProxyRouteIndex([proxySite({ url: "http://127.0.0.1:5000", ssl: false })]);
    expect(one(idx, 5000).ssl).toEqual({ enabled: false });
  });
});
