import { describe, expect, it } from "vitest";
import { coerceProxyValue, PROXY_DIRECTIVE_BY_KEY } from "./proxy-settings";
import {
  isDomainProxySettings,
  resolveDomainProxySettings,
  sanitizeDomainProxySettings,
} from "./domain-proxy-settings";

describe("domain request-body limit precedence (#1431)", () => {
  it("strictly admits imported override objects without silently discarding fields", () => {
    for (const value of [{}, { clientMaxBodySize: "1m" }, { clientMaxBodySize: "0" }])
      expect(isDomainProxySettings(value)).toBe(true);
    for (const value of [
      null,
      [],
      "1m",
      { proxyReadTimeout: "1s" },
      { clientMaxBodySize: "1m", gzip: true },
    ])
      expect(isDomainProxySettings(value)).toBe(false);
  });
  it("overrides only the body cap while retaining the project's other tunables", () => {
    const project = { clientMaxBodySize: "2m", proxyReadTimeout: "120s", gzip: true };
    expect(resolveDomainProxySettings(project, { clientMaxBodySize: "1m", gzip: false })).toEqual({
      clientMaxBodySize: "1m",
      proxyReadTimeout: "120s",
      gzip: true,
    });
    expect(project.clientMaxBodySize).toBe("2m");
  });

  it.each([undefined, null, {}])(
    "inherits without materializing the Edge default (%s)",
    (domain) => {
      expect(resolveDomainProxySettings(undefined, domain)).toBeUndefined();
      expect(resolveDomainProxySettings({ clientMaxBodySize: "2m" }, domain)).toEqual({
        clientMaxBodySize: "2m",
      });
      expect(resolveDomainProxySettings({ clientMaxBodySize: "3m" }, domain)).toEqual({
        clientMaxBodySize: "3m",
      });
    },
  );

  it("keeps explicit unlimited independent of later project edits", () => {
    expect(
      resolveDomainProxySettings({ clientMaxBodySize: "2m" }, { clientMaxBodySize: "0" }),
    ).toEqual({ clientMaxBodySize: "0" });
    expect(
      resolveDomainProxySettings({ clientMaxBodySize: "3m" }, { clientMaxBodySize: "1m" }),
    ).toEqual({ clientMaxBodySize: "1m" });
  });

  it.each([
    "1m; return 200",
    "1M",
    "1mb",
    "-1m",
    "1.5m",
    "20",
    "999999999999999999999999999999999999g",
    "8388608g",
  ])("never renders an invalid or overflowing cap: %s", (value) => {
    const spec = PROXY_DIRECTIVE_BY_KEY.get("clientMaxBodySize")!;
    expect(coerceProxyValue(spec, value)).toBeUndefined();
    expect(sanitizeDomainProxySettings({ clientMaxBodySize: value })).toBeUndefined();
    expect(
      resolveDomainProxySettings({ clientMaxBodySize: "2m" }, { clientMaxBodySize: value }),
    ).toEqual({ clientMaxBodySize: "2m" });
  });
});
