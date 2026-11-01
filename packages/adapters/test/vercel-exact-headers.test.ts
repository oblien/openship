import { describe, expect, it } from "vitest";
import { compileVercelRouting } from "../src/infra/vercel-routing";
import { compileRoutingToOblien } from "../src/runtime/oblien-routing";

describe("Vercel exact header matching", () => {
  it("does not broaden a literal header rule into a prefix on Cloud", () => {
    const config = {
      headers: [
        { source: "/account", headers: [{ key: "Cache-Control", value: "no-store" }] },
        { source: "/assets/:path*", headers: [{ key: "X-Assets", value: "yes" }] },
      ],
    };
    expect(compileVercelRouting(config).headerRules).toEqual([
      { path: "/account", exact: true, headers: config.headers[0]!.headers },
      { path: "/assets/", headers: config.headers[1]!.headers },
    ]);
    expect(compileRoutingToOblien(config).routes.map((r) => r.match)).toEqual([
      { path: "/account", type: "exact" },
      { path: "/assets/", type: "prefix" },
    ]);
  });
});
