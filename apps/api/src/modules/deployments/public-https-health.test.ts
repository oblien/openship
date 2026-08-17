import { describe, expect, it } from "vitest";
import { publicHttpsFromMeta, publicHttpsProbeCommand } from "./public-https-health";

describe("public HTTPS health", () => {
  it("probes the public hostname, not container localhost", () => {
    const cmd = publicHttpsProbeCommand("dashwood.net", "/up");
    expect(cmd).toContain("https://dashwood.net/up");
    expect(cmd).not.toContain("127.0.0.1");
  });

  it("defaults an empty path to /", () => {
    expect(publicHttpsProbeCommand("example.com", "")).toContain("https://example.com/");
  });

  it("reads the last activation result from deployment meta", () => {
    expect(publicHttpsFromMeta(null)).toEqual({ hostname: null, https: "unchecked" });
    expect(
      publicHttpsFromMeta({ publicHttps: { hostname: "dashwood.net", https: "passed" } }),
    ).toEqual({ hostname: "dashwood.net", https: "passed" });
  });
});
