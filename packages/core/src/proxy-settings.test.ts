import { describe, expect, it } from "vitest";

import {
  PROXY_DIRECTIVES,
  PROXY_DIRECTIVE_BY_KEY,
  PROXY_DIRECTIVE_BY_NAME,
  coerceProxyValue,
  expectedProxyState,
  parseProxyValue,
  proxyDirectiveAllowed,
  renderProxyValue,
  resolveProxyDirectives,
  sanitizeProxySettings,
  type ProxyDirectiveSpec,
  type ProxySettings,
} from "./proxy-settings";

/**
 * These values are interpolated into generated nginx config, so the sanitizer is a
 * security boundary, not a convenience: a `;` that survives it closes our directive
 * and opens the attacker's. And because ONE table now drives the type, the API
 * schema, the renderer, the parser and the editor, the failure mode worth guarding
 * is a row that reaches some consumers and not others — a setting that saves,
 * validates, and never renders.
 *
 * So most of what follows is driven by `PROXY_DIRECTIVES` itself rather than by a
 * hand-listed set of fields. A new row with no validator, no render form, or no
 * parse-back fails the suite without anyone remembering to add a case.
 */

/**
 * One valid value per directive, spelled out with the field's own declared type.
 *
 * This is the type-level half of table-completeness: `-?` makes every key required,
 * so `tsc` fails if a row exists in the table with no field on `ProxySettings` (or
 * with the wrong value type), and the runtime checks below fail if `ProxySettings`
 * grows a field with no row. Neither half alone catches a one-sided edit.
 */
type FullSettings = { [K in keyof ProxySettings]-?: NonNullable<ProxySettings[K]> };

const SAMPLE: FullSettings = {
  clientMaxBodySize: "50m",
  clientBodyTimeout: "300s",
  clientBodyBufferSize: "128k",
  proxyRequestBuffering: false,
  proxyConnectTimeout: "10s",
  proxyReadTimeout: "300s",
  proxySendTimeout: "300s",
  sendTimeout: "120s",
  keepaliveTimeout: "75s",
  proxyBuffering: false,
  proxyBufferSize: "16k",
  proxyBuffers: "8 16k",
  proxyBusyBuffersSize: "32k",
  proxyMaxTempFileSize: "0",
  gzip: true,
  gzipCompLevel: 5,
  gzipMinLength: 2048,
  largeClientHeaderBuffers: "4 16k",
  underscoresInHeaders: true,
  serverTokens: false,
  http2: true,
  proxySslServerName: true,
  proxySslVerify: false,
};

/** A second valid value per kind, for cases that need a non-`SAMPLE` value. */
function altValue(spec: ProxyDirectiveSpec): string | number | boolean {
  switch (spec.kind) {
    case "size":
      return "1g";
    case "time":
      return "1h";
    case "buffers":
      return "16 8k";
    case "int":
      return spec.min ?? 1;
    default:
      return false;
  }
}

describe("PROXY_DIRECTIVES is the single source of truth", () => {
  it("has no duplicate keys or directive names", () => {
    // Two rows for one directive would emit it twice; nginx rejects the vhost and
    // the whole project stops serving.
    expect(new Set(PROXY_DIRECTIVES.map((d) => d.key)).size).toBe(PROXY_DIRECTIVES.length);
    expect(new Set(PROXY_DIRECTIVES.map((d) => d.directive)).size).toBe(PROXY_DIRECTIVES.length);
    expect(PROXY_DIRECTIVE_BY_KEY.size).toBe(PROXY_DIRECTIVES.length);
    expect(PROXY_DIRECTIVE_BY_NAME.size).toBe(PROXY_DIRECTIVES.length);
  });

  it("declares every field on ProxySettings, and nothing more", () => {
    const tableKeys = [...PROXY_DIRECTIVES.map((d) => d.key)].sort();
    expect(Object.keys(SAMPLE).sort()).toEqual(tableKeys);
  });

  it("gives every `int` row bounds, so a validator can never be a no-op", () => {
    for (const spec of PROXY_DIRECTIVES.filter((d) => d.kind === "int")) {
      expect(spec.min, spec.key).toBeTypeOf("number");
      expect(spec.max, spec.key).toBeTypeOf("number");
    }
  });

  it("uses lowercase snake_case nginx names", () => {
    for (const spec of PROXY_DIRECTIVES) {
      expect(spec.directive, spec.key).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });
});

describe("sanitizeProxySettings — every directive, driven by the table", () => {
  it("keeps a valid value for every row", () => {
    // The one assertion that says "this row is wired end to end at the type layer":
    // a field the sanitizer doesn't know about vanishes here.
    expect(sanitizeProxySettings(SAMPLE)).toEqual(SAMPLE);
  });

  it("keeps each row on its own, not just in a full object", () => {
    for (const spec of PROXY_DIRECTIVES) {
      const value = (SAMPLE as Record<string, string | number | boolean>)[spec.key]!;
      expect(sanitizeProxySettings({ [spec.key]: value }), spec.key).toEqual({
        [spec.key]: value,
      });
    }
  });

  it("drops an injected value for EVERY row, not just the size fields", () => {
    // A string that closes the directive is the whole reason this layer exists. It
    // must be dropped, never escaped — we do not own an nginx quoting function.
    const attacks = [
      "50m; root /etc",
      "50m;\nroot /etc",
      "50m }\nserver { listen 80;",
      "on; return 301 http://evil",
      "300s #",
      "$request_uri",
      "50m\r\nroot /etc",
    ];
    for (const spec of PROXY_DIRECTIVES) {
      for (const attack of attacks) {
        expect(coerceProxyValue(spec, attack), `${spec.key} <- ${JSON.stringify(attack)}`).toBeUndefined();
        expect(sanitizeProxySettings({ [spec.key]: attack }), spec.key).toBeUndefined();
      }
    }
  });

  it("rejects a value of the wrong shape for every row", () => {
    for (const spec of PROXY_DIRECTIVES) {
      // A bool row must not take a string (`"on"` would render as `on` by accident
      // of String()), and a string row must not take a number (nginx reads a bare
      // `25` as 25 bytes).
      const wrong: unknown[] =
        spec.kind === "bool"
          ? ["on", "off", 1, 0, "true"]
          : spec.kind === "int"
            ? ["5", 1.5, true, Number.NaN]
            : [25, true, null, {}, ["50m"]];
      for (const value of wrong) {
        expect(coerceProxyValue(spec, value), `${spec.key} <- ${JSON.stringify(value)}`).toBeUndefined();
      }
    }
  });

  it("enforces int bounds at both ends", () => {
    for (const spec of PROXY_DIRECTIVES.filter((d) => d.kind === "int")) {
      expect(coerceProxyValue(spec, spec.min!), spec.key).toBe(spec.min);
      expect(coerceProxyValue(spec, spec.max!), spec.key).toBe(spec.max);
      expect(coerceProxyValue(spec, spec.min! - 1), spec.key).toBeUndefined();
      expect(coerceProxyValue(spec, spec.max! + 1), spec.key).toBeUndefined();
    }
  });

  it("requires a unit on sizes, but accepts bare 0", () => {
    // `client_max_body_size 25` is 25 BYTES. Someone who typed 25 meant megabytes,
    // so a unitless value is a mistake we refuse rather than apply.
    expect(sanitizeProxySettings({ clientMaxBodySize: "25" })).toBeUndefined();
    expect(sanitizeProxySettings({ clientMaxBodySize: "25mb" })).toBeUndefined();
    expect(sanitizeProxySettings({ clientMaxBodySize: "-5m" })).toBeUndefined();
    expect(sanitizeProxySettings({ clientMaxBodySize: "0m" })).toBeUndefined();
    // 0 is nginx's "no limit" for body size and "never spool to disk" for temp files.
    expect(sanitizeProxySettings({ clientMaxBodySize: "0" })).toEqual({ clientMaxBodySize: "0" });
    expect(sanitizeProxySettings({ proxyMaxTempFileSize: "0" })).toEqual({
      proxyMaxTempFileSize: "0",
    });
  });

  it("keeps the valid siblings when one field is malformed", () => {
    expect(sanitizeProxySettings({ clientMaxBodySize: "50m", proxyReadTimeout: "nope" })).toEqual({
      clientMaxBodySize: "50m",
    });
  });

  it("returns undefined for empty or non-object input", () => {
    for (const input of [{}, null, undefined, "50m", 5, [], { unknownField: "50m" }]) {
      expect(sanitizeProxySettings(input)).toBeUndefined();
    }
  });
});

describe("render → parse round-trip", () => {
  it("survives for every row, so the renderer and the parser can't drift", () => {
    // The read-back compares a parsed live vhost against what we rendered. If these
    // two disagree on any field, that field reports permanent drift on a box that
    // is serving exactly what we asked for.
    for (const spec of PROXY_DIRECTIVES) {
      const value = (SAMPLE as Record<string, string | number | boolean>)[spec.key]!;
      const text = renderProxyValue(spec, value);
      expect(text, spec.key).not.toMatch(/[;{}\n]/);
      expect(parseProxyValue(spec, text), spec.key).toEqual(value);
      // Whitespace around the argument is normal in hand-written config.
      expect(parseProxyValue(spec, `  ${text}  `), spec.key).toEqual(value);
    }
  });

  it("renders bools as nginx on/off, not true/false", () => {
    for (const spec of PROXY_DIRECTIVES.filter((d) => d.kind === "bool")) {
      expect(renderProxyValue(spec, true), spec.key).toBe("on");
      expect(renderProxyValue(spec, false), spec.key).toBe("off");
    }
  });

  it("normalizes a hand-written value we'd otherwise call 'not set'", () => {
    // nginx accepts `20M` and multiple spaces; our regexes don't. Normalizing on the
    // way IN is what makes a foreign vhost adoptable instead of unreadable.
    const size = PROXY_DIRECTIVE_BY_KEY.get("clientMaxBodySize")!;
    expect(parseProxyValue(size, "20M")).toBe("20m");
    const buffers = PROXY_DIRECTIVE_BY_KEY.get("proxyBuffers")!;
    expect(parseProxyValue(buffers, "8    16K")).toBe("8 16k");
  });

  it("refuses to parse a live value we could not render back", () => {
    // `1d` is valid nginx and outside our curated grammar. Parsing it into the
    // adoptable set would let a save turn it into something else.
    const time = PROXY_DIRECTIVE_BY_KEY.get("proxyReadTimeout")!;
    expect(parseProxyValue(time, "1d")).toBeUndefined();
    const bool = PROXY_DIRECTIVE_BY_KEY.get("gzip")!;
    expect(parseProxyValue(bool, "always")).toBeUndefined();
    const int = PROXY_DIRECTIVE_BY_KEY.get("gzipCompLevel")!;
    expect(parseProxyValue(int, "12")).toBeUndefined();
    expect(parseProxyValue(int, "0x5")).toBeUndefined();
  });
});

describe("resolveProxyDirectives — the one gate", () => {
  it("emits nothing for empty settings", () => {
    expect(resolveProxyDirectives(undefined, { scope: "all" })).toEqual([]);
    expect(resolveProxyDirectives({}, { scope: "all" })).toEqual([]);
    expect(resolveProxyDirectives({ clientMaxBodySize: "bad" }, { scope: "all" })).toEqual([]);
  });

  it("keeps TLS-only directives out of the shared scope", () => {
    // `http2 on` inside the `listen 80` block enables cleartext h2c, which no
    // browser negotiates — and every generated vhost has a :80 block.
    const shared = resolveProxyDirectives(SAMPLE, { scope: "shared" }).map((d) => d.directive);
    const tls = resolveProxyDirectives(SAMPLE, { scope: "tls" }).map((d) => d.directive);
    const all = resolveProxyDirectives(SAMPLE, { scope: "all" }).map((d) => d.directive);

    const tlsOnly = PROXY_DIRECTIVES.filter((d) => d.tlsOnly).map((d) => d.directive);
    expect(tlsOnly.length).toBeGreaterThan(0);
    for (const name of tlsOnly) {
      expect(shared, name).not.toContain(name);
      expect(tls, name).toContain(name);
    }
    expect(new Set(all)).toEqual(new Set([...shared, ...tls]));
  });

  it("emits every non-TLS row exactly once for a full settings object", () => {
    const lines = resolveProxyDirectives(SAMPLE, { scope: "shared" });
    for (const spec of PROXY_DIRECTIVES.filter((d) => !d.tlsOnly)) {
      expect(lines.filter((l) => l.directive === spec.directive).length, spec.key).toBe(1);
    }
  });

  it("never emits a directive twice, companions included", () => {
    const names = resolveProxyDirectives({ ...SAMPLE, gzip: true }, { scope: "all" }).map(
      (d) => d.directive,
    );
    expect(new Set(names).size).toBe(names.length);
  });

  it("carries gzip's companions when gzip is on, and drops them when it's off", () => {
    const on = resolveProxyDirectives({ gzip: true }, { scope: "shared" });
    expect(on.map((d) => d.directive)).toEqual([
      "gzip",
      "gzip_types",
      "gzip_vary",
      "gzip_min_length",
    ]);
    // The MIME set is a fixed constant, never user input.
    expect(on.find((d) => d.directive === "gzip_types")!.text).toContain("application/json");

    const off = resolveProxyDirectives({ gzip: false }, { scope: "shared" });
    expect(off.map((d) => d.directive)).toEqual(["gzip"]);
    expect(off[0]!.text).toBe("off");
  });

  it("lets an explicit value beat the companion default", () => {
    const lines = resolveProxyDirectives({ gzip: true, gzipMinLength: 256 }, { scope: "shared" });
    const minLength = lines.filter((d) => d.directive === "gzip_min_length");
    expect(minLength).toHaveLength(1);
    expect(minLength[0]!.text).toBe("256");
  });

  it("skips a directive the box's nginx is too old for", () => {
    // `http2 on;` at server scope arrived in 1.25.1; before that it belonged on the
    // `listen` line, so emitting it fails `openresty -t` and the vhost rolls back —
    // the operator's setting disappears with no explanation.
    const http2 = PROXY_DIRECTIVE_BY_KEY.get("http2")!;
    const names = (version: Parameters<typeof proxyDirectiveAllowed>[1]) =>
      resolveProxyDirectives({ http2: true }, { scope: "tls", nginxVersion: version }).map(
        (d) => d.directive,
      );

    expect(names([1, 24, 0])).toEqual([]);
    expect(names([1, 25, 0])).toEqual([]);
    expect(names([1, 25, 1])).toEqual(["http2"]);
    expect(names([1, 27, 1])).toEqual(["http2"]);
    expect(names([2, 0, 0])).toEqual(["http2"]);
    // Unknown version → allow. Detection reads `openresty -V`, which is missing on
    // some executors, and `openresty -t` + rollback is the net.
    expect(names(null)).toEqual(["http2"]);
    expect(names(undefined)).toEqual(["http2"]);
    expect(proxyDirectiveAllowed(http2, [1, 25, 1])).toBe(true);
  });

  it("leaves version-independent directives alone on an ancient box", () => {
    const names = resolveProxyDirectives(SAMPLE, {
      scope: "all",
      nginxVersion: [1, 18, 0],
    }).map((d) => d.directive);
    expect(names).toContain("client_max_body_size");
    expect(names).not.toContain("http2");
  });
});

describe("expectedProxyState — what a read-back must compare against", () => {
  it("includes the companion values, so gzip isn't permanent false drift", () => {
    // The bug this exists to prevent: `gzip: true` renders `gzip_min_length 1024`,
    // and a read-back that compared the live vhost against the raw settings saw a
    // value nobody asked for and reported drift forever.
    expect(expectedProxyState({ gzip: true }, { tls: true })).toEqual({
      gzip: true,
      gzipMinLength: 1024,
    });
  });

  it("agrees with the resolved directive list on every key", () => {
    const state = expectedProxyState(SAMPLE, { tls: true });
    const lines = resolveProxyDirectives(SAMPLE, { scope: "all" });
    for (const line of lines) {
      if (line.key === undefined) continue;
      expect(state[line.key], line.directive).toEqual(line.value);
    }
    // gzip_types has no tunable behind it, so it must NOT invent a key.
    expect(Object.keys(state).sort()).toEqual(
      [...new Set(lines.flatMap((l) => (l.key ? [l.key] : [])))].sort(),
    );
  });

  it("expects nothing TLS-only from a plaintext vhost", () => {
    const plain = expectedProxyState(SAMPLE, { tls: false });
    expect(plain.http2).toBeUndefined();
    expect(expectedProxyState(SAMPLE, { tls: true }).http2).toBe(true);
  });

  it("expects nothing at all when the project configured nothing", () => {
    expect(expectedProxyState(null, { tls: true })).toEqual({});
    expect(expectedProxyState({ clientMaxBodySize: "20M" }, { tls: true })).toEqual({});
  });

  it("reflects the version gate, so an old box isn't reported as drifting", () => {
    expect(expectedProxyState({ http2: true }, { tls: true, nginxVersion: [1, 24, 0] })).toEqual({});
    expect(expectedProxyState({ http2: true }, { tls: true, nginxVersion: [1, 27, 1] })).toEqual({
      http2: true,
    });
  });

  it("round-trips an alternate value per row through the state", () => {
    for (const spec of PROXY_DIRECTIVES) {
      const value = altValue(spec);
      const state = expectedProxyState({ [spec.key]: value }, { tls: true });
      expect(state[spec.key], spec.key).toEqual(value);
    }
  });
});
