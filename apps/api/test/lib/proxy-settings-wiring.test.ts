import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { PROXY_DIRECTIVES, sanitizeProxySettings, type ProxyDirectiveSpec } from "@repo/core";
import { UpdateProjectBody } from "../../src/modules/projects/project.schema";

/**
 * OpenResty inherits nginx's defaults, so an upload over 1 MB is a 413 and anything
 * slower than 60s is cut off. `ProxySettings` (packages/core) is how a project
 * raises those, stored on `project.routingConfig.proxy`.
 *
 * These values are interpolated straight into generated nginx config, so they are
 * validated TWICE on purpose — once by the API schema on write, once by
 * `sanitizeProxySettings` immediately before rendering. This file pins that the two
 * agree: a value the API accepts must be one the renderer keeps, or the setting
 * would save successfully and then silently do nothing.
 */

const validate = (proxy: unknown) =>
  Value.Check(UpdateProjectBody, { routingConfig: { proxy } });

describe("ProxySettings — the API schema and the renderer agree", () => {
  const GOOD = [
    { clientMaxBodySize: "25m" },
    { clientMaxBodySize: "1g" },
    { clientMaxBodySize: "512k" },
    { proxyReadTimeout: "300s" },
    { proxyReadTimeout: "5m" },
    { clientBodyTimeout: "1h" },
    { proxyBuffering: false },
    { gzip: true },
    { clientMaxBodySize: "50m", proxyReadTimeout: "300s", clientBodyTimeout: "300s" },
  ];

  it("accepts every valid shape, and the renderer keeps it", () => {
    for (const proxy of GOOD) {
      expect(validate(proxy), `schema rejected ${JSON.stringify(proxy)}`).toBe(true);
      expect(sanitizeProxySettings(proxy), `renderer dropped ${JSON.stringify(proxy)}`).toEqual(proxy);
    }
  });

  const BAD = [
    { clientMaxBodySize: "25" },        // no unit — nginx would read it as bytes
    { clientMaxBodySize: "25mb" },      // not an nginx size suffix
    { clientMaxBodySize: "0m" },        // leading zero excluded by the regex
    { clientMaxBodySize: "-5m" },
    { clientMaxBodySize: "25m; root /etc" }, // the injection this guards against
    { proxyReadTimeout: "300" },        // no unit
    { proxyReadTimeout: "300ms" },      // not one of the accepted time forms
    { clientMaxBodySize: 25 },          // wrong type
  ];

  it("rejects malformed values at the API, and the renderer drops them too", () => {
    for (const proxy of BAD) {
      expect(validate(proxy), `schema accepted ${JSON.stringify(proxy)}`).toBe(false);
      // Belt and braces: even if one slipped past the schema, nothing reaches config.
      expect(
        sanitizeProxySettings(proxy)?.clientMaxBodySize ?? sanitizeProxySettings(proxy)?.proxyReadTimeout,
      ).toBeUndefined();
    }
  });

  it("accepts a routing config with no proxy block at all", () => {
    expect(Value.Check(UpdateProjectBody, { routingConfig: { cleanUrls: true } })).toBe(true);
    expect(Value.Check(UpdateProjectBody, { routingConfig: null })).toBe(true);
  });

  it("treats an empty proxy block as nothing configured", () => {
    // The editor drops cleared fields rather than persisting blanks, so `{}` is what
    // arrives when the last value is removed — it must not render an empty directive.
    expect(validate({})).toBe(true);
    expect(sanitizeProxySettings({})).toBeUndefined();
  });
});

/**
 * The hand-written cases above cover the fields an operator actually reaches for. These
 * are driven by `PROXY_DIRECTIVES` itself, so adding a row to the table without giving
 * it a schema property fails HERE rather than at the point a user saves it and watches
 * the value vanish. The schema is generated from the same table, which is exactly why
 * the completeness check has to come from outside it.
 */
function sampleFor(spec: ProxyDirectiveSpec): string | number | boolean {
  switch (spec.kind) {
    case "size":
      return "50m";
    case "time":
      return "300s";
    case "buffers":
      return "8 16k";
    case "int":
      return spec.min ?? 1;
    default:
      return true;
  }
}

/** A value of the right SHAPE for the kind but outside what nginx will take. */
function badFor(spec: ProxyDirectiveSpec): string | number | boolean {
  switch (spec.kind) {
    case "size":
      return "50mb";
    case "time":
      return "300ms";
    case "buffers":
      return "8";
    case "int":
      return (spec.max ?? 9) + 1;
    default:
      return "yes";
  }
}

describe("ProxySettings — every directive in the table is wired end to end", () => {
  it("accepts a sample value for every row, and the renderer keeps it", () => {
    for (const spec of PROXY_DIRECTIVES) {
      const proxy = { [spec.key]: sampleFor(spec) };
      expect(validate(proxy), `schema rejected ${spec.directive}`).toBe(true);
      expect(sanitizeProxySettings(proxy), `renderer dropped ${spec.directive}`).toEqual(proxy);
    }
  });

  it("accepts every row set at once (no field excludes another)", () => {
    const all = Object.fromEntries(PROXY_DIRECTIVES.map((s) => [s.key, sampleFor(s)]));
    expect(validate(all)).toBe(true);
    expect(sanitizeProxySettings(all)).toEqual(all);
  });

  it("rejects an out-of-range value for every row at BOTH gates", () => {
    for (const spec of PROXY_DIRECTIVES) {
      const proxy = { [spec.key]: badFor(spec) };
      expect(validate(proxy), `schema accepted bad ${spec.directive}`).toBe(false);
      expect(
        sanitizeProxySettings(proxy)?.[spec.key as keyof ReturnType<typeof sanitizeProxySettings> & string],
        `renderer kept bad ${spec.directive}`,
      ).toBeUndefined();
    }
  });

  it("rejects an injection attempt for every row at BOTH gates", () => {
    // Nothing quotes these — they are interpolated into a config file — so a value
    // carrying `;`, a newline or a brace must never get past either gate.
    const attacks = ["50m; root /etc", "50m\nroot /etc", "50m }\nserver { listen 80;"];
    for (const spec of PROXY_DIRECTIVES) {
      for (const attack of attacks) {
        const proxy = { [spec.key]: attack };
        expect(validate(proxy), `schema accepted ${spec.directive}=${attack}`).toBe(false);
        expect(sanitizeProxySettings(proxy), `renderer kept ${spec.directive}=${attack}`).toBeUndefined();
      }
    }
  });

  it("never renders a key that isn't in the table", () => {
    // The schema is permissive about extra properties (like every sibling schema in
    // RoutingConfig), so the table IS the allow-list: the sanitizer is what stops an
    // unknown key — a typo, or an attempt to smuggle a directive we don't curate —
    // from ever reaching a config file.
    expect(sanitizeProxySettings({ clientMaxBodySize: "50m", clientMaxBodySizes: "1g" })).toEqual({
      clientMaxBodySize: "50m",
    });
    expect(sanitizeProxySettings({ add_header: "X-Evil 1" })).toBeUndefined();
  });
});

/**
 * A project's tunables are only real if EVERY path that writes one of its vhosts
 * carries them. They didn't: the compose paths dropped them, so a project with
 * services applied its 50 MB limit to the main app and 413'd on the service's own
 * domain — the kind of gap that reads as "the setting doesn't work, sometimes".
 *
 * Driving `deployComposeServices` needs a runtime, a docker host and a repo layer, so
 * this pins the payloads as a source contract instead: a new `registerRoute` call in
 * one of these files that forgets the spread fails here. The behaviour those payloads
 * produce is covered against the real renderer in `proxy-settings-e2e.test.ts`.
 */
function source(rel: string): string {
  return readFileSync(new URL(rel, import.meta.url), "utf8");
}

/** The `{...}` argument of every `registerRoute(` call in `src`, brace-balanced. */
function registerRoutePayloads(src: string): string[] {
  const out: string[] = [];
  const call = ".registerRoute(";
  for (let at = src.indexOf(call); at !== -1; at = src.indexOf(call, at + 1)) {
    const open = src.indexOf("{", at);
    if (open === -1 || open > src.indexOf(")", at) + 1) continue; // called with a variable
    let depth = 0;
    for (let i = open; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}" && --depth === 0) {
        out.push(src.slice(open, i + 1));
        break;
      }
    }
  }
  return out;
}

describe("ProxySettings — every project vhost writer carries them", () => {
  const compose = source("../../src/modules/deployments/compose/deploy.service.ts");

  it("resolves them ONCE per compose deploy, sanitized, off the project", () => {
    // Sanitized here rather than at the callers, because the row can also carry a
    // value seeded from a repo config — not just one the API schema already checked.
    expect(compose).toContain("sanitizeProxySettings(project.routingConfig?.proxy)");
  });

  it("spreads them into every compose route: service, composite and path fan-out", () => {
    const payloads = registerRoutePayloads(compose);
    expect(payloads.length).toBeGreaterThanOrEqual(3);
    for (const p of payloads) {
      expect(p, `a compose registerRoute payload drops the tunables:\n${p}`).toContain(
        "routeContext.proxy",
      );
    }
  });

  it("spreads them on the live apply path too (a save must not need a redeploy)", () => {
    const payloads = registerRoutePayloads(source("../../src/lib/route-apply.service.ts"));
    expect(payloads).not.toHaveLength(0);
    for (const p of payloads) expect(p).toMatch(/\.\.\.\(proxy \? \{ proxy \} : \{\}\)/);
  });
});
