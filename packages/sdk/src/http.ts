import { SDK_CAPABILITIES, SDK_SCOPE_HEADER } from "@repo/contracts";
import { abortable } from "./cancellation";
import { ApiError, responseError } from "./errors";
import { parseSSE, type SSEEvent } from "./events";
import { iteratePages } from "./pagination";

function requestSignal(signal?: AbortSignal | null, timeoutMs?: number): AbortSignal | undefined {
  if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs < 0))
    throw new TypeError("timeoutMs must be a nonnegative finite number");
  const signals = [signal, timeoutMs ? AbortSignal.timeout(timeoutMs) : null]
    .filter((value): value is AbortSignal => value != null);
  return signals.length ? AbortSignal.any(signals) : undefined;
}


export interface HttpClientOptions {
  /** Instance URL, optionally ending in /api or including a reverse-proxy prefix. */
  baseUrl: string;
  token?: string | (() => string | undefined | Promise<string | undefined>);
  /** Explicit installation operator credential; cannot be combined with a tenant or bearer. */
  internalToken?: string | (() => string | Promise<string>);
  organizationId?: string;
  fetch?: typeof globalThis.fetch;
  userAgent?: string;
  /** Request deadline. Zero disables it; stream lifetime is controlled by its signal. */
  timeoutMs?: number;
}

export interface HttpRequestOptions extends RequestInit {
  timeoutMs?: number;
  /** Required by Node fetch when uploading a stream. */
  duplex?: "half";
}

export interface PaginateOptions<T = unknown> {
  perPage?: number;
  pageParam?: string;
  perPageParam?: string;
  query?: Record<string, string | number | boolean | undefined>;
  extract?: (body: unknown) => { items: T[]; total?: number };
  signal?: AbortSignal;
}

/** Instance-confined transport shared by resource methods, uploads, and the CLI. */
export class HttpClient {
  readonly apiUrl: string;
  readonly organizationId?: string;
  private readonly options: Readonly<HttpClientOptions>;
  private readonly fetcher: typeof globalThis.fetch;
  private scopeSupport?: Promise<void>;

  constructor(options: HttpClientOptions) {
    const url = new URL(options.baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
      throw new TypeError("baseUrl must be an HTTP(S) instance URL without credentials, query, or fragment");
    const base = url.href.replace(/\/+$/, "");
    this.apiUrl = base.endsWith("/api") ? base : base + "/api";
    const org = options.organizationId;
    if (options.internalToken !== undefined && (options.token !== undefined || org !== undefined))
      throw new TypeError("An internal operator credential cannot be combined with token or organizationId");
    if (org !== undefined && (typeof org !== "string" || !org.trim() || org !== org.trim()))
      throw new TypeError("organizationId must be a nonempty identifier without surrounding whitespace");
    if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 0))
      throw new TypeError("timeoutMs must be a nonnegative finite number");
    this.organizationId = org;
    this.options = Object.freeze({ ...options });
    this.fetcher = options.fetch ?? ((...args) => globalThis.fetch(...args));
  }

  /** Resolves only API paths on this instance, never arbitrary credential-bearing URLs. */
  url(path: string): URL {
    const base = new URL(this.apiUrl);
    const url = new URL(/^https?:\/\//i.test(path) ? path : this.apiUrl + "/" + path.replace(/^\/+/, ""));
    if (
      url.origin !== base.origin || url.username || url.password || url.hash ||
      (url.pathname !== base.pathname && !url.pathname.startsWith(base.pathname + "/"))
    ) throw new TypeError("API requests must stay within the configured instance API");
    return url;
  }

  private async requireScopeSupport(signal?: AbortSignal | null): Promise<void> {
    if (!this.organizationId) return;
    signal?.throwIfAborted();
    this.scopeSupport ??= (async () => {
      const response = await this.fetcher(this.apiUrl + "/health", {
        headers: { Accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(this.options.timeoutMs || 30_000),
      });
      const health = await response.json().catch(() => null) as {
        sdk?: { protocol?: number; fixedOrganizationScope?: boolean };
      } | null;
      if (!response.ok || health?.sdk?.protocol !== SDK_CAPABILITIES.protocol || health.sdk.fixedOrganizationScope !== true)
        throw new ApiError(
          "This server does not support fixed SDK tenant scopes. Upgrade the server before using organizationId.",
          409,
          { code: "SDK_SCOPE_UNSUPPORTED" },
        );
    })().catch((error) => {
      this.scopeSupport = undefined;
      throw error;
    });
    await abortable(this.scopeSupport, signal);
    signal?.throwIfAborted();
  }

  async raw(path: string, options: HttpRequestOptions = {}): Promise<Response> {
    const url = this.url(path);
    const { timeoutMs = this.options.timeoutMs, ...init } = options;
    const signal = requestSignal(init.signal, timeoutMs);
    signal?.throwIfAborted();
    const headers = new Headers(init.headers);
    // FormData must retain fetch's generated multipart boundary.
    if (!headers.has("Content-Type") && !(init.body instanceof FormData))
      headers.set("Content-Type", "application/json");
    if (!headers.has("User-Agent")) headers.set("User-Agent", this.options.userAgent ?? "openship-sdk/client");
    await this.requireScopeSupport(signal);
    const token = this.options.token;
    const credential = typeof token === "function" ? await abortable(Promise.resolve().then(token), signal) : token;
    if (credential) headers.set("Authorization", "Bearer " + credential);
    const internalToken = this.options.internalToken;
    if (internalToken !== undefined) {
      const internal = typeof internalToken === "function" ? await abortable(Promise.resolve().then(internalToken), signal) : internalToken;
      if (typeof internal !== "string" || !internal.trim()) throw new TypeError("internalToken must be nonempty");
      headers.set("X-Internal-Token", internal);
    }
    if (this.organizationId) {
      headers.set("X-Organization-Id", this.organizationId);
      headers.set(SDK_SCOPE_HEADER, "fixed");
    }
    signal?.throwIfAborted();
    return this.fetcher(url.href, { ...init, headers, signal, redirect: "error" });
  }

  async request<T = unknown>(path: string, options?: HttpRequestOptions): Promise<T> {
    const response = await this.raw(path, options);
    if (!response.ok) throw await responseError(response);
    if (response.status === 204) return undefined as T;
    try {
      return await response.json() as T;
    } catch {
      throw new ApiError("Invalid JSON response", 502, null);
    }
  }

  async *paginate<T = unknown>(path: string, options: PaginateOptions<T> = {}): AsyncGenerator<T> {
    const { perPage = 50, pageParam = "page", perPageParam = "perPage" } = options;
    const extract = options.extract ?? ((body: unknown) => {
      if (!body || typeof body !== "object" || !("data" in body) || !Array.isArray(body.data))
        throw new ApiError("Invalid pagination response", 502, body);
      return { items: body.data as T[], total: "total" in body && typeof body.total === "number" ? body.total : undefined };
    });
    const url = this.url(path);
    for (const [key, value] of Object.entries(options.query ?? {}))
      if (value !== undefined) url.searchParams.set(key, String(value));
    yield* iteratePages(async ({ page, perPage }) => {
      url.searchParams.set(pageParam, String(page));
      url.searchParams.set(perPageParam, String(perPage));
      const { items, total } = extract(await this.request(url.href, { signal: options.signal }));
      return { data: items, total };
    }, { perPage, signal: options.signal });
  }

  async *events(path: string, options: HttpRequestOptions = {}): AsyncGenerator<SSEEvent> {
    const headers = new Headers(options.headers);
    headers.set("Accept", "text/event-stream");
    const response = await this.raw(path, { timeoutMs: 0, ...options, headers });
    if (!response.ok) throw await responseError(response);
    if (!response.body) throw new ApiError("No response body for SSE stream", response.status, null);
    yield* parseSSE(response.body);
  }

  /** Upload targets supply their own credentials; the API bearer never leaves this instance. */
  async upload(target: { url: string; method?: string; headers?: Record<string, string> }, body: NonNullable<RequestInit["body"]>, options: HttpRequestOptions = {}): Promise<void> {
    const headers = new Headers(target.headers);
    if (!headers.has("Content-Type")) headers.set("Content-Type", "application/gzip");
    const { timeoutMs = this.options.timeoutMs, ...request } = options;
    const signal = requestSignal(request.signal, timeoutMs);
    const init = { ...request, signal, method: target.method ?? "POST", headers, body, redirect: "error" as const };
    let response: Response;
    if (/^https?:\/\//i.test(target.url)) {
      const url = new URL(target.url);
      if (url.username || url.password || url.hash) throw new TypeError("Invalid upload URL");
      signal?.throwIfAborted();
      response = await this.fetcher(url.href, init);
    } else {
      response = await this.raw(target.url, init);
    }
    if (!response.ok) throw await responseError(response);
    await response.body?.cancel();
  }
}
