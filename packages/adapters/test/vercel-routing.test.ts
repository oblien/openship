import { describe, expect, it } from "vitest";

import { compileVercelRouting, sourceToLocation } from "../src/infra/vercel-routing";

describe("sourceToLocation", () => {
  it("reduces a path-to-regexp source to a prefix", () => {
    expect(sourceToLocation("/api/(.*)")).toEqual({ path: "/api/", exact: false });
    expect(sourceToLocation("/api/:path*")).toEqual({ path: "/api/", exact: false });
  });
  it("marks a literal path as exact", () => {
    expect(sourceToLocation("/old")).toEqual({ path: "/old", exact: true });
  });
  it("rejects non-absolute sources", () => {
    expect(sourceToLocation("api")).toBeNull();
  });
});

describe("compileVercelRouting", () => {
  it("maps an /api rewrite to the backend proxy and flags the SPA fallback", () => {
    const out = compileVercelRouting(
      {
        rewrites: [
          { source: "/api/(.*)", destination: "/api/index.js" },
          { source: "/(.*)", destination: "/index.html" },
        ],
      },
      { backendTargetUrl: "http://10.0.0.5:3000" },
    );
    expect(out.proxyLocations).toEqual([{ pathPrefix: "/api/", targetUrl: "http://10.0.0.5:3000" }]);
    expect(out.spaFallback).toBe(true);
  });

  it("proxies a full-URL rewrite destination directly", () => {
    const out = compileVercelRouting({
      rewrites: [{ source: "/proxy/(.*)", destination: "https://api.example.com/$1" }],
    });
    expect(out.proxyLocations).toEqual([
      { pathPrefix: "/proxy/", targetUrl: "https://api.example.com/$1" },
    ]);
  });

  it("compiles redirects with the right status code", () => {
    const out = compileVercelRouting({
      redirects: [
        { source: "/old", destination: "/new", permanent: true },
        { source: "/tmp", destination: "/temp" },
        { source: "/x", destination: "/y", statusCode: 302 },
      ],
    });
    expect(out.redirects).toEqual([
      { path: "/old", exact: true, statusCode: 308, destination: "/new" },
      { path: "/tmp", exact: true, statusCode: 307, destination: "/temp" },
      { path: "/x", exact: true, statusCode: 302, destination: "/y" },
    ]);
  });

  it("normalizes a non-3xx or out-of-range redirect status to a safe default", () => {
    const out = compileVercelRouting({
      redirects: [
        { source: "/a", destination: "/x", statusCode: 200 },
        { source: "/b", destination: "/y", statusCode: 999 },
        { source: "/c", destination: "/z", statusCode: 302.5 },
        { source: "/d", destination: "/w", statusCode: 404, permanent: true },
      ],
    });
    expect(out.redirects).toEqual([
      { path: "/a", exact: true, statusCode: 307, destination: "/x" },
      { path: "/b", exact: true, statusCode: 307, destination: "/y" },
      { path: "/c", exact: true, statusCode: 307, destination: "/z" },
      { path: "/d", exact: true, statusCode: 308, destination: "/w" },
    ]);
  });

  it("compiles header rules and passes through cleanUrls/trailingSlash", () => {
    const out = compileVercelRouting({
      headers: [{ source: "/(.*)", headers: [{ key: "X-Frame-Options", value: "DENY" }] }],
      cleanUrls: true,
      trailingSlash: false,
    });
    expect(out.headerRules).toEqual([{ path: "/", headers: [{ key: "X-Frame-Options", value: "DENY" }] }]);
    expect(out.cleanUrls).toBe(true);
    expect(out.trailingSlash).toBe(false);
  });

  it("skips a path rewrite when there is no backend to proxy to", () => {
    const out = compileVercelRouting({ rewrites: [{ source: "/api/(.*)", destination: "/api" }] });
    expect(out.proxyLocations).toEqual([]);
    expect(out.skipped.length).toBe(1);
  });

  it("rejects nginx-injection attempts from untrusted vercel.json", () => {
    const out = compileVercelRouting(
      {
        rewrites: [{ source: "/evil; } location / { proxy_pass http://x; }", destination: "/api" }],
        redirects: [{ source: "/r", destination: "/y; return 200 'pwned'" }],
        headers: [{ source: "/(.*)", headers: [{ key: "X-Bad", value: 'a"; add_header Evil "1' }] }],
      },
      { backendTargetUrl: "http://10.0.0.5:3000" },
    );
    expect(out.proxyLocations).toEqual([]); // malicious source path rejected
    expect(out.redirects).toEqual([]); // unsafe destination rejected
    expect(out.headerRules).toEqual([]); // unsafe header value rejected
    expect(out.skipped.length).toBeGreaterThanOrEqual(3);
  });
});
