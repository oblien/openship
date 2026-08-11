import { describe, expect, it } from "vitest";

import { compileProjectRoutingFields } from "../../src/lib/project-routing-fields";

/**
 * `registerRoute` REPLACES the whole vhost, so a register site that omits these fields
 * DELETES them rather than leaving them alone. This helper is the single definition every
 * site spreads; these tests pin the contract those sites depend on.
 */
describe("compileProjectRoutingFields", () => {
  it("returns nothing for a project with no routing config", () => {
    expect(compileProjectRoutingFields(null)).toEqual({});
    expect(compileProjectRoutingFields(undefined)).toEqual({});
    // An empty config must not produce keys either — a `redirects: []` would still be a
    // spread that overwrites, and `cleanUrls: false` reads as an explicit opt-out.
    expect(compileProjectRoutingFields({})).toEqual({});
  });

  it("carries redirects, headers and cleanUrls through", () => {
    const fields = compileProjectRoutingFields({
      cleanUrls: true,
      redirects: [{ source: "/blog/:path*", destination: "/news/:path*", permanent: true }],
      headers: [{ source: "/api/(.*)", headers: [{ key: "Cache-Control", value: "no-store" }] }],
    });
    expect(fields.cleanUrls).toBe(true);
    expect(fields.redirects).toEqual([
      { path: "/blog/", exact: false, statusCode: 308, destination: "/news/$1", pattern: "/blog/(.*)" },
    ]);
    expect(fields.headerRules).toEqual([
      { path: "/api/", headers: [{ key: "Cache-Control", value: "no-store" }] },
    ]);
  });

  // The tri-state is the point: `false` means "strip the slash" and emits the OPPOSITE
  // redirect from `true`, so a truthiness read would silently turn it into "don't care".
  it("distinguishes trailingSlash false from absent", () => {
    expect(compileProjectRoutingFields({ trailingSlash: false })).toEqual({ trailingSlash: false });
    expect(compileProjectRoutingFields({ trailingSlash: true })).toEqual({ trailingSlash: true });
    expect(compileProjectRoutingFields({})).not.toHaveProperty("trailingSlash");
  });

  // No `backendTargetUrl` here on purpose — which upstream a PATH rewrite belongs to is a
  // topology question a single register site cannot answer. A full-URL rewrite needs no
  // backend and still compiles.
  it("compiles a full-URL rewrite but leaves a path rewrite to the topology-aware path", () => {
    const full = compileProjectRoutingFields({
      rewrites: [{ source: "/proxy/:path*", destination: "https://api.example.com/v2/:path*" }],
    });
    expect(full.proxyLocations).toEqual([
      {
        pathPrefix: "/proxy/",
        external: true,
        targetUrl: "https://api.example.com",
        pattern: "/proxy/(.*)",
        upstreamPath: "/v2/$1",
      },
    ]);

    const path = compileProjectRoutingFields({
      rewrites: [{ source: "/api/(.*)", destination: "/api/index.js" }],
    });
    expect(path.proxyLocations).toBeUndefined();
  });

  it("drops a rule the compiler refuses instead of forwarding it", () => {
    // `$http_x_target` in the host would become `proxy_pass http://$http_x_target` — an
    // open proxy steered by a request header.
    const fields = compileProjectRoutingFields({
      rewrites: [{ source: "/p/:path*", destination: "http://$http_x_target/:path*" }],
      redirects: [{ source: "/.well-known/x", destination: "/y", permanent: true }],
    });
    expect(fields.proxyLocations).toBeUndefined();
    expect(fields.redirects).toBeUndefined();
  });

  // A dropped rule that says nothing is the failure mode: the operator edits vercel.json,
  // the deploy goes green, and the rule simply isn't there. `onSkipped` is how the caller
  // gets to say so — see the JSDoc for why only the no-composite path may wire it.
  it("reports each refused rule through onSkipped, and stays silent when all compile", () => {
    const notes: string[] = [];
    compileProjectRoutingFields(
      {
        rewrites: [{ source: "/p/:path*", destination: "http://$http_x_target/:path*" }],
        redirects: [{ source: "/.well-known/x", destination: "/y", permanent: true }],
      },
      (note) => notes.push(note),
    );
    expect(notes).toHaveLength(2);
    expect(notes.join("\n")).toContain("/p/:path*");
    expect(notes.join("\n")).toContain("/.well-known/x");

    const quiet: string[] = [];
    const fields = compileProjectRoutingFields({ cleanUrls: true }, (note) => quiet.push(note));
    expect(fields).toEqual({ cleanUrls: true });
    expect(quiet).toEqual([]);
  });

  // The callback is the ONLY thing it adds: a caller that passes none must get back exactly
  // what it got before, so the three sites that spread this can ignore the parameter.
  it("returns the same fields whether or not a reporter is passed", () => {
    const config = {
      cleanUrls: true,
      rewrites: [
        { source: "/proxy/:path*", destination: "https://api.example.com/v2/:path*" },
        { source: "/api/(.*)", destination: "/api/index.js" },
      ],
    };
    expect(compileProjectRoutingFields(config)).toEqual(compileProjectRoutingFields(config, () => {}));
  });
});
