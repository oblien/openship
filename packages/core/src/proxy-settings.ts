/**
 * Reverse-proxy tunables rendered into the OpenResty edge vhost. CURATED +
 * strictly validated — never arbitrary nginx passthrough, since these values are
 * interpolated into generated config.
 *
 * `PROXY_DIRECTIVES` below is the ONE declaration of what exists. The TS type, the
 * sanitizer, the API schema (`project.schema.ts`), the renderer (`renderProxyOptions`
 * in adapters), the config parser that reads values back off a live box
 * (`system/proxy/import/nginx.ts`) and the dashboard editor are all derived from it.
 * Adding a directive is one row here plus an i18n label — do not hand-add a field to
 * any consumer, or the halves drift and a setting saves but never renders.
 *
 * Configured at exactly ONE level: `project.routingConfig.proxy`, applied to every
 * route the project owns (`route-apply.service.ts`, `build-pipeline.ts` and the
 * compose deploy service are the readers). Self-hosted only.
 *
 * A server-default layer under it and a per-service override above it were
 * intended and are not built — there is no storage for either, so don't infer
 * a cascade from this file. Adding one means new columns plus a field-by-field
 * merge at the read sites; the ordering to implement is server < project < service.
 */

/**
 * Byte size: digits + a k/m/g suffix (nginx `size`). The suffix is REQUIRED for
 * anything non-zero: nginx reads a bare `25` as 25 bytes, and someone who typed 25
 * into an upload-limit box meant megabytes, so we reject it rather than silently
 * apply a limit 10^6 times smaller than intended.
 *
 * Bare `0` is the one exception, because nginx gives it a distinct meaning —
 * `client_max_body_size 0` disables the check entirely, `proxy_max_temp_file_size 0`
 * disables buffering to disk.
 */
export const PROXY_SIZE_RE = /^(0|[1-9][0-9]*(k|m|g))$/;
/** Time: digits + s/m/h (the nginx `time` forms we allow). */
export const PROXY_TIME_RE = /^[1-9][0-9]*(s|m|h)$/;
/** `proxy_buffers` takes two arguments: a count and a size, e.g. "8 16k". */
export const PROXY_BUFFERS_RE = /^[1-9][0-9]* [1-9][0-9]*(k|m|g)?$/;

/** Fixed, safe gzip MIME set emitted when gzip is enabled — never user input. */
export const PROXY_GZIP_TYPES =
  "text/plain text/css application/json application/javascript text/xml " +
  "application/xml application/xml+rss text/javascript image/svg+xml";

/**
 * How a value is validated and rendered.
 * - `size`/`time`/`buffers` — string, matched against the regex above.
 * - `int` — integer within [min, max].
 * - `bool` — rendered as nginx `on`/`off`.
 */
export type ProxyDirectiveKind = "size" | "time" | "int" | "bool" | "buffers";

/** UI grouping. Purely presentational, but declared here so it can't drift either. */
export type ProxyDirectiveGroup =
  | "body"
  | "timeouts"
  | "buffering"
  | "compression"
  | "headers"
  | "upstreamTls";

export interface ProxyDirectiveSpec {
  /** camelCase key on `ProxySettings` / the stored JSON. */
  readonly key: string;
  /** The nginx directive name emitted (and parsed back). */
  readonly directive: string;
  readonly kind: ProxyDirectiveKind;
  readonly group: ProxyDirectiveGroup;
  /** `int` bounds, inclusive. */
  readonly min?: number;
  readonly max?: number;
  /**
   * Minimum nginx version, when the directive's syntax is version-dependent.
   * `http2 on;` is only valid from 1.25.1 — older boxes need it on the `listen`
   * line, so the renderer skips the entry rather than write config that fails
   * `openresty -t`.
   */
  readonly minNginx?: readonly [number, number, number];
  /**
   * Extra literal lines emitted when a bool directive is ON. Fixed strings, never
   * user input — this is how gzip carries its MIME set and its sensible defaults.
   *
   * A companion is a DEFAULT: the renderer drops any whose directive the operator
   * set explicitly, so `gzip_min_length` stays at our 1024 unless the project
   * chooses otherwise, instead of emitting the directive twice.
   */
  readonly companionsWhenOn?: readonly string[];
  /**
   * Emit only in the TLS server block. `http2` is the case: in a `listen 80` block
   * it would turn on cleartext h2c, which no browser negotiates and which some
   * intermediaries mishandle — and every generated vhost has a :80 block, including
   * the one that only exists to answer the ACME challenge.
   */
  readonly tlsOnly?: boolean;
}

/**
 * The curated set. Server-scope directives only, so they can be emitted once per
 * `server {}` block and inherited by every `location` inside it.
 *
 * Deliberately absent: anything requiring an `upstream {}` block
 * (`proxy_next_upstream`, keepalive pools) or an http-scope declaration
 * (`proxy_cache`, which needs `proxy_cache_path`) — those are separate features,
 * not tunables. Policy (rate limits, CORS, method filters) belongs to the route
 * rules Lua engine and `headerRules`, not here.
 */
export const PROXY_DIRECTIVES: readonly ProxyDirectiveSpec[] = [
  // ── Request body ────────────────────────────────────────────────────────
  { key: "clientMaxBodySize", directive: "client_max_body_size", kind: "size", group: "body" },
  { key: "clientBodyTimeout", directive: "client_body_timeout", kind: "time", group: "body" },
  {
    key: "clientBodyBufferSize",
    directive: "client_body_buffer_size",
    kind: "size",
    group: "body",
  },
  {
    key: "proxyRequestBuffering",
    directive: "proxy_request_buffering",
    kind: "bool",
    group: "body",
  },

  // ── Upstream timeouts ───────────────────────────────────────────────────
  { key: "proxyConnectTimeout", directive: "proxy_connect_timeout", kind: "time", group: "timeouts" },
  { key: "proxyReadTimeout", directive: "proxy_read_timeout", kind: "time", group: "timeouts" },
  { key: "proxySendTimeout", directive: "proxy_send_timeout", kind: "time", group: "timeouts" },
  { key: "sendTimeout", directive: "send_timeout", kind: "time", group: "timeouts" },
  { key: "keepaliveTimeout", directive: "keepalive_timeout", kind: "time", group: "timeouts" },

  // ── Response buffering ──────────────────────────────────────────────────
  { key: "proxyBuffering", directive: "proxy_buffering", kind: "bool", group: "buffering" },
  { key: "proxyBufferSize", directive: "proxy_buffer_size", kind: "size", group: "buffering" },
  { key: "proxyBuffers", directive: "proxy_buffers", kind: "buffers", group: "buffering" },
  {
    key: "proxyBusyBuffersSize",
    directive: "proxy_busy_buffers_size",
    kind: "size",
    group: "buffering",
  },
  {
    key: "proxyMaxTempFileSize",
    directive: "proxy_max_temp_file_size",
    kind: "size",
    group: "buffering",
  },

  // ── Compression ─────────────────────────────────────────────────────────
  {
    key: "gzip",
    directive: "gzip",
    kind: "bool",
    group: "compression",
    companionsWhenOn: [
      `gzip_types ${PROXY_GZIP_TYPES}`,
      "gzip_vary on",
      // nginx's own default is 20 bytes, small enough that the gzip header costs
      // more than the compression saves.
      "gzip_min_length 1024",
    ],
  },
  {
    key: "gzipCompLevel",
    directive: "gzip_comp_level",
    kind: "int",
    group: "compression",
    min: 1,
    max: 9,
  },
  // Bytes, as an int — the natural unit here is "1024", and `size` would force "1k".
  {
    key: "gzipMinLength",
    directive: "gzip_min_length",
    kind: "int",
    group: "compression",
    min: 0,
    max: 10_485_760,
  },

  // ── Headers & limits ────────────────────────────────────────────────────
  {
    key: "largeClientHeaderBuffers",
    directive: "large_client_header_buffers",
    kind: "buffers",
    group: "headers",
  },
  {
    key: "underscoresInHeaders",
    directive: "underscores_in_headers",
    kind: "bool",
    group: "headers",
  },
  { key: "serverTokens", directive: "server_tokens", kind: "bool", group: "headers" },
  {
    key: "http2",
    directive: "http2",
    kind: "bool",
    group: "headers",
    // `http2 on;` at server scope replaced `listen ... http2` in nginx 1.25.1.
    minNginx: [1, 25, 1],
    tlsOnly: true,
  },

  // ── TLS to the upstream ─────────────────────────────────────────────────
  {
    key: "proxySslServerName",
    directive: "proxy_ssl_server_name",
    kind: "bool",
    group: "upstreamTls",
  },
  { key: "proxySslVerify", directive: "proxy_ssl_verify", kind: "bool", group: "upstreamTls" },
] as const;

/** Directive spec by camelCase key. */
export const PROXY_DIRECTIVE_BY_KEY: ReadonlyMap<string, ProxyDirectiveSpec> = new Map(
  PROXY_DIRECTIVES.map((d) => [d.key, d]),
);

/** Directive spec by nginx directive name — the parser's lookup. */
export const PROXY_DIRECTIVE_BY_NAME: ReadonlyMap<string, ProxyDirectiveSpec> = new Map(
  PROXY_DIRECTIVES.map((d) => [d.directive, d]),
);

/**
 * Reverse-proxy tunables. Every key comes from `PROXY_DIRECTIVES`; the value type
 * follows the entry's `kind` (bool → boolean, int → number, everything else → the
 * nginx string form). Widened to the union rather than generated per-key so the
 * type stays readable — `sanitizeProxySettings` is what enforces per-key types.
 */
export type ProxySettings = {
  clientMaxBodySize?: string;
  clientBodyTimeout?: string;
  clientBodyBufferSize?: string;
  proxyRequestBuffering?: boolean;
  proxyConnectTimeout?: string;
  proxyReadTimeout?: string;
  proxySendTimeout?: string;
  sendTimeout?: string;
  keepaliveTimeout?: string;
  proxyBuffering?: boolean;
  proxyBufferSize?: string;
  proxyBuffers?: string;
  proxyBusyBuffersSize?: string;
  proxyMaxTempFileSize?: string;
  gzip?: boolean;
  gzipCompLevel?: number;
  gzipMinLength?: number;
  largeClientHeaderBuffers?: string;
  underscoresInHeaders?: boolean;
  serverTokens?: boolean;
  http2?: boolean;
  proxySslServerName?: boolean;
  proxySslVerify?: boolean;
};

/** Regex for a string-valued kind, or undefined for bool/int. */
export function proxyKindRegex(kind: ProxyDirectiveKind): RegExp | undefined {
  switch (kind) {
    case "size":
      return PROXY_SIZE_RE;
    case "time":
      return PROXY_TIME_RE;
    case "buffers":
      return PROXY_BUFFERS_RE;
    default:
      return undefined;
  }
}

/**
 * Per-field validators for the string directives. Derived from the table; kept as
 * an export because the API schema and tests both read it.
 */
export const PROXY_STRING_FIELD_RE: Readonly<Record<string, RegExp>> = Object.freeze(
  Object.fromEntries(
    PROXY_DIRECTIVES.flatMap((d) => {
      const re = proxyKindRegex(d.kind);
      return re ? [[d.key, re] as const] : [];
    }),
  ),
);

/**
 * Validate one value against its directive spec. Returns the value to store, or
 * undefined to drop it. Shared by the sanitizer and by the config parser deciding
 * whether a live value is adoptable.
 */
export function coerceProxyValue(
  spec: ProxyDirectiveSpec,
  value: unknown,
): string | number | boolean | undefined {
  if (spec.kind === "bool") return typeof value === "boolean" ? value : undefined;
  if (spec.kind === "int") {
    if (typeof value !== "number" || !Number.isInteger(value)) return undefined;
    if (spec.min !== undefined && value < spec.min) return undefined;
    if (spec.max !== undefined && value > spec.max) return undefined;
    return value;
  }
  const re = proxyKindRegex(spec.kind);
  if (typeof value !== "string" || !re || !re.test(value)) return undefined;
  return value;
}

/**
 * Keep only valid fields; drop anything malformed rather than trust the caller.
 * Defense-in-depth alongside the API schema — the renderer calls this before
 * emitting, so a bad value can never reach the generated nginx config. Returns
 * undefined when nothing valid remains.
 */
export function sanitizeProxySettings(input: unknown): ProxySettings | undefined {
  if (!input || typeof input !== "object") return undefined;
  const src = input as Record<string, unknown>;
  const out: Record<string, string | number | boolean> = {};
  for (const spec of PROXY_DIRECTIVES) {
    if (!(spec.key in src)) continue;
    const v = coerceProxyValue(spec, src[spec.key]);
    if (v !== undefined) out[spec.key] = v;
  }
  return Object.keys(out).length > 0 ? (out as ProxySettings) : undefined;
}

/** Render one directive's value in nginx form. */
export function renderProxyValue(
  spec: ProxyDirectiveSpec,
  value: string | number | boolean,
): string {
  if (spec.kind === "bool") return value ? "on" : "off";
  return String(value);
}

/** Semantic version triple, as parsed off `openresty -V`. */
export type NginxVersion = readonly [number, number, number];

/**
 * May this directive be emitted on a box running `version`?
 *
 * Default-allow when the version is UNKNOWN: detection reads `openresty -V`, which
 * is unavailable before install and on some container executors, and the edge image
 * is well past every `minNginx` we declare. A wrong guess is caught immediately —
 * `registerRoute` runs `openresty -t` and rolls the vhost back on failure — whereas
 * defaulting to skip would silently drop a setting the operator switched on.
 */
export function proxyDirectiveAllowed(
  spec: ProxyDirectiveSpec,
  version?: NginxVersion | null,
): boolean {
  if (!spec.minNginx || !version) return true;
  for (let i = 0; i < 3; i++) {
    const need = spec.minNginx[i] ?? 0;
    const have = version[i] ?? 0;
    if (have > need) return true;
    if (have < need) return false;
  }
  return true;
}

/**
 * One directive line a vhost will carry: the nginx name, the rendered argument
 * text, and — for lines that correspond to a tunable rather than a fixed companion
 * — the `ProxySettings` key and typed value behind it.
 */
export interface ResolvedProxyDirective {
  readonly directive: string;
  /** Rendered argument(s), no trailing semicolon. */
  readonly text: string;
  readonly key?: string;
  readonly value?: string | number | boolean;
}

/**
 * Resolve settings into the ordered directive lines a server block should carry.
 *
 * THE single gate — kind, tlsOnly scope, version floor, companion defaults — with
 * two consumers that must not disagree: the renderer (turns these into config text)
 * and the live read-back (compares them against what the box actually serves). When
 * drift detection computed its own expectation, `gzip: true` reported a permanent
 * false drift on `gzip_min_length`, because only the renderer knew about companions.
 *
 * `scope`: "shared" = the directives every server block gets, "tls" = the TLS-only
 * ones (see `tlsOnly`), "all" = both, i.e. everything a TLS vhost ends up serving.
 */
export function resolveProxyDirectives(
  settings: unknown,
  opts: { scope: "shared" | "tls" | "all"; nginxVersion?: NginxVersion | null },
): ResolvedProxyDirective[] {
  const p = sanitizeProxySettings(settings);
  if (!p) return [];
  const values = p as Record<string, string | number | boolean>;
  // A companion is a DEFAULT: an explicitly-set directive wins, and we must not
  // emit the same directive twice.
  const explicit = new Set(
    PROXY_DIRECTIVES.filter((s) => values[s.key] !== undefined).map((s) => s.directive),
  );
  const out: ResolvedProxyDirective[] = [];

  for (const spec of PROXY_DIRECTIVES) {
    const wanted = opts.scope === "all" || (opts.scope === "tls") === !!spec.tlsOnly;
    if (!wanted) continue;
    if (!proxyDirectiveAllowed(spec, opts.nginxVersion)) continue;
    const value = values[spec.key];
    if (value === undefined) continue;

    out.push({ directive: spec.directive, text: renderProxyValue(spec, value), key: spec.key, value });

    if (value !== true || !spec.companionsWhenOn) continue;
    for (const line of spec.companionsWhenOn) {
      const [name, ...rest] = line.split(/\s+/);
      if (!name || explicit.has(name)) continue;
      const text = rest.join(" ");
      // A companion that is ALSO a tunable (gzip_min_length) carries its key, so a
      // read-back knows to expect it; the rest (gzip_types) are text only.
      const companion = PROXY_DIRECTIVE_BY_NAME.get(name);
      const parsed = companion ? parseProxyValue(companion, text) : undefined;
      out.push({
        directive: name,
        text,
        ...(companion && parsed !== undefined ? { key: companion.key, value: parsed } : {}),
      });
    }
  }
  return out;
}

/**
 * The directive values a vhost rendered from `settings` will actually serve —
 * companions and version/scope gating included. Compare a live parse against this,
 * never against the raw settings, or every companion reads as drift.
 */
export function expectedProxyState(
  settings: unknown,
  opts: { tls: boolean; nginxVersion?: NginxVersion | null },
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const d of resolveProxyDirectives(settings, {
    scope: opts.tls ? "all" : "shared",
    ...(opts.nginxVersion !== undefined ? { nginxVersion: opts.nginxVersion } : {}),
  })) {
    if (d.key !== undefined && d.value !== undefined) out[d.key] = d.value;
  }
  return out;
}

/** Parse an nginx directive argument string back into a `ProxySettings` value. */
export function parseProxyValue(
  spec: ProxyDirectiveSpec,
  raw: string,
): string | number | boolean | undefined {
  const text = raw.trim();
  if (spec.kind === "bool") {
    if (text === "on") return true;
    if (text === "off") return false;
    return undefined;
  }
  if (spec.kind === "int") {
    if (!/^[0-9]+$/.test(text)) return undefined;
    return coerceProxyValue(spec, Number(text));
  }
  // nginx accepts uppercase suffixes (`20M`); normalize so a hand-written vhost
  // round-trips into a value we can render, instead of reading as "not set".
  const normalized = spec.kind === "buffers" ? text.replace(/\s+/g, " ") : text;
  return coerceProxyValue(spec, normalized.toLowerCase());
}
