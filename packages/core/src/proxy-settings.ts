/**
 * Reverse-proxy tunables rendered into the OpenResty edge vhost (and the
 * server-wide default include). CURATED + strictly validated — never arbitrary
 * nginx passthrough, since these values are interpolated into generated config.
 *
 * Configurable at three levels: server default < project < service, merged
 * field-by-field (most specific wins) before rendering. Self-hosted only.
 */

export interface ProxySettings {
  /** nginx `client_max_body_size` — max request/upload body size, e.g. "25m". */
  clientMaxBodySize?: string;
  /** nginx `proxy_read_timeout` — upstream read timeout, e.g. "60s". */
  proxyReadTimeout?: string;
  /** nginx `proxy_send_timeout` — upstream send timeout. */
  proxySendTimeout?: string;
  /** nginx `client_body_timeout` — client body read timeout. */
  clientBodyTimeout?: string;
  /** nginx `proxy_buffering` on/off. */
  proxyBuffering?: boolean;
  /** nginx `gzip` on/off. The MIME set is a fixed constant, never user input. */
  gzip?: boolean;
}

/** Byte size: digits + k/m/g (nginx `size`). */
export const PROXY_SIZE_RE = /^[1-9][0-9]*(k|m|g)$/;
/** Time: digits + s/m/h (the nginx `time` forms we allow). */
export const PROXY_TIME_RE = /^[1-9][0-9]*(s|m|h)$/;

/** Fixed, safe gzip MIME set emitted when gzip is enabled — never user input. */
export const PROXY_GZIP_TYPES =
  "text/plain text/css application/json application/javascript text/xml " +
  "application/xml application/xml+rss text/javascript image/svg+xml";

/** Per-field validators for the string directives. */
export const PROXY_STRING_FIELD_RE: Readonly<Record<string, RegExp>> = {
  clientMaxBodySize: PROXY_SIZE_RE,
  proxyReadTimeout: PROXY_TIME_RE,
  proxySendTimeout: PROXY_TIME_RE,
  clientBodyTimeout: PROXY_TIME_RE,
};

/**
 * Keep only valid fields; drop anything malformed rather than trust the caller.
 * Defense-in-depth alongside the API schema — the renderer calls this before
 * emitting, so a bad value can never reach the generated nginx config. Returns
 * undefined when nothing valid remains.
 */
export function sanitizeProxySettings(input: unknown): ProxySettings | undefined {
  if (!input || typeof input !== "object") return undefined;
  const src = input as Record<string, unknown>;
  const out: ProxySettings = {};
  for (const [key, re] of Object.entries(PROXY_STRING_FIELD_RE)) {
    const v = src[key];
    if (typeof v === "string" && re.test(v)) {
      (out as Record<string, string>)[key] = v;
    }
  }
  if (typeof src.proxyBuffering === "boolean") out.proxyBuffering = src.proxyBuffering;
  if (typeof src.gzip === "boolean") out.gzip = src.gzip;
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Field-by-field merge; later layers win. Used as
 * `mergeProxySettings(serverDefault, project, service)` so the most specific
 * override applies per field while inheriting the rest.
 */
export function mergeProxySettings(
  ...layers: (ProxySettings | null | undefined)[]
): ProxySettings | undefined {
  const out: ProxySettings = {};
  for (const layer of layers) {
    if (!layer) continue;
    for (const [k, v] of Object.entries(layer)) {
      if (v !== undefined) (out as Record<string, unknown>)[k] = v;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
