import { describe, it, expect } from "vitest";
import type { ImportedSite } from "@repo/adapters";
import { buildProxyRouteIndex } from "./proxy-route-scan";

const proxySite = (over: Partial<ImportedSite> & { url: string }): ImportedSite => ({
  serverNames: over.serverNames ?? ["app.example.com"],
  ssl: over.ssl ?? false,
  target: { kind: "proxy", url: over.url },
  tls: over.tls,
  source: over.source,
});

describe("buildProxyRouteIndex", () => {
  it("maps a proxied vhost to its upstream host port with domains + ssl + cert", () => {
    const idx = buildProxyRouteIndex([
      proxySite({
        url: "http://127.0.0.1:3000",
        serverNames: ["app.example.com"],
        ssl: true,
        tls: { certPath: "/etc/letsencrypt/live/app/fullchain.pem", keyPath: "/etc/letsencrypt/live/app/privkey.pem" },
        source: "/etc/nginx/sites-enabled/app",
      }),
    ]);
    expect(idx.get(3000)).toEqual({
      port: 3000,
      domains: ["app.example.com"],
      ssl: {
        enabled: true,
        certPath: "/etc/letsencrypt/live/app/fullchain.pem",
        keyPath: "/etc/letsencrypt/live/app/privkey.pem",
      },
      source: "/etc/nginx/sites-enabled/app",
    });
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
    const route = idx.get(8080)!;
    expect(route.domains.sort()).toEqual(["a.example.com", "b.example.com"]);
    expect(route.ssl).toEqual({ enabled: true, certPath: "/c/fullchain.pem", keyPath: "/c/privkey.pem" });
  });

  it("reports ssl disabled when no TLS on the vhost", () => {
    const idx = buildProxyRouteIndex([proxySite({ url: "http://127.0.0.1:5000", ssl: false })]);
    expect(idx.get(5000)?.ssl).toEqual({ enabled: false });
  });
});
