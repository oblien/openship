import { describe, expect, it } from "vitest";

import {
  compileVercelRouting,
  sourceToLocation,
  sourceToPattern,
} from "../src/infra/vercel-routing";

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

describe("sourceToPattern", () => {
  it("compiles each param modifier to its capture", () => {
    expect(sourceToPattern("/blog/:path*")).toEqual({ pattern: "/blog/(.*)", names: ["path"] });
    expect(sourceToPattern("/blog/:path+")).toEqual({ pattern: "/blog/(.+)", names: ["path"] });
    expect(sourceToPattern("/u/:id")).toEqual({ pattern: "/u/([^/]+)", names: ["id"] });
    expect(sourceToPattern("/u/:id?")).toEqual({ pattern: "/u/([^/]*)", names: ["id"] });
  });

  it("compiles an anonymous group and escapes literal dots", () => {
    expect(sourceToPattern("/docs/(.*)")).toEqual({ pattern: "/docs/(.*)", names: [""] });
    expect(sourceToPattern("/v1.0/:rest*")).toEqual({ pattern: "/v1\\.0/(.*)", names: ["rest"] });
  });

  it("keeps captures ordered across multiple params", () => {
    expect(sourceToPattern("/:org/:repo/(.*)")).toEqual({
      pattern: "/([^/]+)/([^/]+)/(.*)",
      names: ["org", "repo", ""],
    });
  });

  it("rejects sources with nothing to capture, custom groups, or unsafe chars", () => {
    expect(sourceToPattern("/old")).toBeNull(); // no wildcard
    expect(sourceToPattern("/u/:id(\\d+)")).toBeNull(); // custom regex group
    expect(sourceToPattern("/a/(a|b)")).toBeNull(); // alternation
    expect(sourceToPattern("/evil; } location / { #")).toBeNull();
    expect(sourceToPattern("blog/:path*")).toBeNull(); // not absolute
    expect(sourceToPattern("/at/12:30")).toBeNull(); // `:30` is a literal, not a param
  });

  it("rejects more captures than nginx can back-reference", () => {
    expect(sourceToPattern("/:a/:b/:c/:d/:e/:f/:g/:h/:i")).not.toBeNull();
    expect(sourceToPattern("/:a/:b/:c/:d/:e/:f/:g/:h/:i/:j")).toBeNull();
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
    expect(out.proxyLocations).toEqual([
      { pathPrefix: "/api/", targetUrl: "http://10.0.0.5:3000" },
    ]);
    expect(out.spaFallback).toBe(true);
  });

  it("proxies a capture-free full-URL rewrite destination directly", () => {
    const out = compileVercelRouting({
      rewrites: [{ source: "/proxy/(.*)", destination: "https://api.example.com/fixed" }],
    });
    expect(out.proxyLocations).toEqual([
      { pathPrefix: "/proxy/", external: true, targetUrl: "https://api.example.com/fixed" },
    ]);
  });

  it("refuses raw loopback rewrite destinations from repo configuration", () => {
    const out = compileVercelRouting({
      rewrites: [
        { source: "/ipv4/(.*)", destination: "http://127.0.0.1:23000/$1" },
        { source: "/ipv6/(.*)", destination: "http://[::ffff:127.0.0.1]:23001/$1" },
        { source: "/wildcard/(.*)", destination: "http://0.0.0.0:23002/$1" },
      ],
    });

    expect(out.proxyLocations).toEqual([]);
    expect(out.skipped).toHaveLength(3);
    expect(out.skipped.every((note) => note.includes("loopback destinations"))).toBe(true);
  });

  // Previously the destination was handed to `proxy_pass` verbatim, so `$1` expanded to
  // empty in a prefix location and `/proxy/foo` reached the origin as `/`. The capture
  // now becomes a `rewrite … break` template against a regex location, and the origin is
  // split off so `proxy_pass` keeps no variable (which would need a `resolver`).
  it("splits a capture-bearing rewrite into origin + upstream path template", () => {
    const out = compileVercelRouting({
      rewrites: [
        { source: "/proxy/(.*)", destination: "https://api.example.com/$1" },
        { source: "/p/:rest*", destination: "https://api.example.com/v2/:rest*" },
      ],
    });
    expect(out.proxyLocations).toEqual([
      {
        pathPrefix: "/proxy/",
        external: true,
        targetUrl: "https://api.example.com",
        pattern: "/proxy/(.*)",
        upstreamPath: "/$1",
      },
      {
        pathPrefix: "/p/",
        external: true,
        targetUrl: "https://api.example.com",
        pattern: "/p/(.*)",
        upstreamPath: "/v2/$1",
      },
    ]);
    expect(out.skipped).toEqual([]);
  });

  it("skips a rewrite whose destination references a capture the source lacks", () => {
    const out = compileVercelRouting({
      rewrites: [{ source: "/p/:r*", destination: "https://api.example.com/:q*" }],
    });
    expect(out.proxyLocations).toEqual([]);
    expect(out.skipped.length).toBe(1);
  });

  it("leaves a backend-bound path rewrite on its prefix location, not marked external", () => {
    const out = compileVercelRouting(
      { rewrites: [{ source: "/api/(.*)", destination: "/api/index.js" }] },
      { backendTargetUrl: "http://10.0.0.5:3000" },
    );
    expect(out.proxyLocations).toEqual([
      { pathPrefix: "/api/", targetUrl: "http://10.0.0.5:3000" },
    ]);
  });

  // Vercel documents `permanent` as defaulting to TRUE ("when true, the status code is
  // 308"), and its own /blog/:path* → /news/:path* example as a 308. An absent key
  // therefore means permanent; only an explicit `false` is temporary.
  it("compiles redirects with the right status code", () => {
    const out = compileVercelRouting({
      redirects: [
        { source: "/old", destination: "/new", permanent: true },
        { source: "/tmp", destination: "/temp", permanent: false },
        { source: "/dflt", destination: "/d" },
        { source: "/x", destination: "/y", statusCode: 302 },
      ],
    });
    expect(out.redirects).toEqual([
      { path: "/old", exact: true, statusCode: 308, destination: "/new" },
      { path: "/tmp", exact: true, statusCode: 307, destination: "/temp" },
      { path: "/dflt", exact: true, statusCode: 308, destination: "/d" },
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
      { path: "/a", exact: true, statusCode: 308, destination: "/x" },
      { path: "/b", exact: true, statusCode: 308, destination: "/y" },
      { path: "/c", exact: true, statusCode: 308, destination: "/z" },
      { path: "/d", exact: true, statusCode: 308, destination: "/w" },
    ]);
  });

  // #510: a prefix location captures nothing, so `:path*` used to reach the browser
  // verbatim (`Location: /news/:path*`) and `$1` expanded to empty.
  it("compiles a wildcard redirect to a capture pattern instead of a prefix", () => {
    const out = compileVercelRouting({
      redirects: [{ source: "/blog/:path*", destination: "/news/:path*", permanent: true }],
    });
    expect(out.redirects).toEqual([
      {
        path: "/blog/",
        exact: false,
        statusCode: 308,
        destination: "/news/$1",
        pattern: "/blog/(.*)",
      },
    ]);
    expect(out.skipped).toEqual([]);
  });

  it("resolves `(.*)` / `$1` and renamed params to the right capture index", () => {
    const out = compileVercelRouting({
      redirects: [
        { source: "/docs/(.*)", destination: "/documentation/$1" },
        { source: "/blog/:slug*", destination: "/news/:slug*" },
        { source: "/:org/old/:rest*", destination: "/:org/new/:rest*", permanent: true },
      ],
    });
    expect(out.redirects).toEqual([
      {
        path: "/docs/",
        exact: false,
        statusCode: 308,
        destination: "/documentation/$1",
        pattern: "/docs/(.*)",
      },
      {
        path: "/blog/",
        exact: false,
        statusCode: 308,
        destination: "/news/$1",
        pattern: "/blog/(.*)",
      },
      {
        path: "/",
        exact: false,
        statusCode: 308,
        destination: "/$1/new/$2",
        pattern: "/([^/]+)/old/(.*)",
      },
    ]);
  });

  it("carries a capture into a full-URL destination without touching its origin", () => {
    const out = compileVercelRouting({
      redirects: [{ source: "/blog/:path*", destination: "https://blog.example.com:8443/:path*" }],
    });
    expect(out.redirects).toEqual([
      {
        path: "/blog/",
        exact: false,
        statusCode: 308,
        destination: "https://blog.example.com:8443/$1",
        pattern: "/blog/(.*)",
      },
    ]);
  });

  it("leaves a destination that references no capture on the prefix location", () => {
    const out = compileVercelRouting({
      redirects: [{ source: "/blog/:path*", destination: "/news", permanent: true }],
    });
    expect(out.redirects).toEqual([
      { path: "/blog/", exact: false, statusCode: 308, destination: "/news" },
    ]);
  });

  // `:` is a legal path character, and a param name is an identifier — so `:30` is
  // never a reference to a param called `30`, whatever the source looks like.
  it("treats a non-identifier colon in the destination as a literal", () => {
    const out = compileVercelRouting({
      redirects: [
        { source: "/meet", destination: "/at/12:30", permanent: true },
        { source: "/m/:p*", destination: "/at/12:30" }, // wildcard source, still literal
      ],
    });
    expect(out.redirects).toEqual([
      { path: "/meet", exact: true, statusCode: 308, destination: "/at/12:30" },
      { path: "/m/", exact: false, statusCode: 308, destination: "/at/12:30" },
    ]);
    expect(out.skipped).toEqual([]);
  });

  it("still skips `:name` when the source IS a pattern we could not compile", () => {
    // The opposite of the case above: `:id` here refers to a capture we failed to
    // build, so passing it through would put `:id` in the Location header (#510).
    const out = compileVercelRouting({
      redirects: [
        { source: "/u/:id(\\d+)", destination: "/user/:id" }, // reference → skip
        { source: "/u/:id(\\d+)", destination: "/users" }, // no reference → fine
      ],
    });
    expect(out.redirects).toEqual([
      { path: "/u/", exact: false, statusCode: 308, destination: "/users" },
    ]);
    expect(out.skipped.length).toBe(1);
  });

  it("substitutes a capture into a query string", () => {
    const out = compileVercelRouting({
      redirects: [{ source: "/s/:q*", destination: "/search?q=:q*" }],
    });
    expect(out.redirects[0]).toMatchObject({ destination: "/search?q=$1", pattern: "/s/(.*)" });
  });

  it("needs the regex for a destination already written in nginx `$1` form", () => {
    // The rewrite is a no-op on the string, but the location still has to capture.
    const out = compileVercelRouting({
      redirects: [{ source: "/blog/:path*", destination: "/news/$1" }],
    });
    expect(out.redirects[0]).toMatchObject({ destination: "/news/$1", pattern: "/blog/(.*)" });
  });

  it("skips a redirect whose destination references a capture the source lacks", () => {
    const out = compileVercelRouting({
      redirects: [
        { source: "/old", destination: "/new/$1" }, // static source captures nothing
        { source: "/blog/:path*", destination: "/news/:slug*" }, // wrong param name
        { source: "/blog/:path*", destination: "/news/$2" }, // out-of-range group
      ],
    });
    expect(out.redirects).toEqual([]);
    expect(out.skipped.length).toBe(3);
  });

  // Only `$1..$9` are captures; every other `$…` is an nginx runtime variable that a
  // vercel.json must not be able to interpolate into the emitted `return`.
  it("skips a destination that smuggles an nginx variable or a config comment", () => {
    const out = compileVercelRouting({
      redirects: [
        { source: "/a/:path*", destination: "/b/$request_uri" },
        { source: "/c", destination: "/d$host" },
        { source: "/e", destination: "/f#top" },
      ],
    });
    expect(out.redirects).toEqual([]);
    expect(out.skipped.length).toBe(3);
  });

  it("compiles header rules and passes through cleanUrls/trailingSlash", () => {
    const out = compileVercelRouting({
      headers: [{ source: "/(.*)", headers: [{ key: "X-Frame-Options", value: "DENY" }] }],
      cleanUrls: true,
      trailingSlash: false,
    });
    expect(out.headerRules).toEqual([
      { path: "/", headers: [{ key: "X-Frame-Options", value: "DENY" }] },
    ]);
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
        headers: [
          { source: "/(.*)", headers: [{ key: "X-Bad", value: 'a"; add_header Evil "1' }] },
        ],
      },
      { backendTargetUrl: "http://10.0.0.5:3000" },
    );
    expect(out.proxyLocations).toEqual([]); // malicious source path rejected
    expect(out.redirects).toEqual([]); // unsafe destination rejected
    expect(out.headerRules).toEqual([]); // unsafe header value rejected
    expect(out.skipped.length).toBeGreaterThanOrEqual(3);
  });
});
