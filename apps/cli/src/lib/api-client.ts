/**
 * CLI HTTP client — talks to the Openship API using the active context's PAT.
 * No Origin header is sent, so the API accepts the Bearer token (its anti-XSS
 * guard only rejects bearer auth from browser-trusted origins).
 */
import { getApiUrl as getConfiguredApiUrl, getToken } from "./config";

/** Base API URL including the /api prefix, resolved from the active context. */
export function getApiUrl(): string {
  return `${getConfiguredApiUrl()}/api`;
}

/** Thrown on non-2xx responses. Surfaces the API's {error} body plus status. */
export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

function buildHeaders(extra?: RequestInit["headers"]): Headers {
  const headers = new Headers(extra);
  if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const token = getToken();
  if (token && !headers.has("Authorization")) headers.set("Authorization", `Bearer ${token}`);
  return headers;
}

/**
 * Raw request — returns the Response without parsing or throwing on status.
 * Used by streaming callers (SSE) that need the body stream. `path` is relative
 * to /api (e.g. "/deployments"); pass an absolute URL to bypass the base.
 */
export async function apiRaw(path: string, options?: RequestInit): Promise<Response> {
  const url = path.startsWith("http") ? path : `${getApiUrl()}${path}`;
  return fetch(url, { ...options, headers: buildHeaders(options?.headers) });
}

/** JSON request. Throws ApiError on non-2xx. Returns parsed body as T. */
export async function apiRequest<T = unknown>(path: string, options?: RequestInit): Promise<T> {
  const res = await apiRaw(path, options);
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const message = (body.error as string) || (body.message as string) || `API error: ${res.status}`;
    throw new ApiError(message, res.status, body);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export interface PaginateOptions {
  /** Page size sent as perPageParam. Default 50. */
  perPage?: number;
  /** Query name for the page number. Default "page". */
  pageParam?: string;
  /** Query name for the page size. Default "perPage". */
  perPageParam?: string;
  /** Extra query params merged into every request. */
  query?: Record<string, string | number | boolean | undefined>;
  /**
   * Pull the items + total out of one page's body. Default reads the standard
   * Openship envelope: { data: T[], total?: number }.
   */
  extract?: (body: unknown) => { items: unknown[]; total?: number };
}

function toQuery(params: Record<string, string | number | boolean | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) sp.set(k, String(v));
  const s = sp.toString();
  return s ? `?${s}` : "";
}

/**
 * Iterate every item across paginated pages. Walks pages until a page returns
 * no items, or the running count reaches the reported total.
 */
export async function* paginate<T = unknown>(
  path: string,
  opts: PaginateOptions = {},
): AsyncGenerator<T, void, unknown> {
  const perPage = opts.perPage ?? 50;
  const pageParam = opts.pageParam ?? "page";
  const perPageParam = opts.perPageParam ?? "perPage";
  const extract =
    opts.extract ??
    ((body: unknown) => {
      const b = body as { data?: unknown[]; total?: number };
      return { items: b.data ?? [], total: b.total };
    });

  const sep = path.includes("?") ? "&" : "";
  let page = 1;
  let seen = 0;
  for (;;) {
    const qs = toQuery({ ...opts.query, [pageParam]: page, [perPageParam]: perPage });
    const body = await apiRequest(`${path}${sep}${qs.slice(sep ? 1 : 0)}`);
    const { items, total } = extract(body);
    for (const item of items) yield item as T;
    seen += items.length;
    if (items.length === 0) return;
    if (typeof total === "number" && seen >= total) return;
    if (items.length < perPage) return;
    page += 1;
  }
}
