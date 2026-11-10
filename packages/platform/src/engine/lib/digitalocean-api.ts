import { AppError } from "@repo/core";

export class DigitalOceanApiError extends AppError {
  constructor(
    public readonly providerStatus: number,
    message: string,
  ) {
    super(`DigitalOcean: ${message}`, 502, "DIGITALOCEAN_API_ERROR");
  }
}

/** DigitalOcean's maximum page size. */
const PER_PAGE = 200;

/**
 * Hard stop on the pagination loop. 10 000 records is far beyond any zone we
 * manage; this exists so a `links.pages.next` that never ends can't spin us.
 */
const MAX_PAGES = 50;

interface DigitalOceanErrorBody {
  id?: string;
  message?: string;
}

/** Never echo the token. Guarded: `replaceAll("")` would insert the mask between every character. */
function redact(text: string, token: string): string {
  return token ? text.replaceAll(token, "[redacted]") : text;
}

/**
 * One bounded transport for the v2 API. Never include requests or response
 * bodies in errors: a body pasted into a support thread must not carry a token.
 * Returns `undefined` for a 204 (DELETE answers with no body).
 */
export async function digitaloceanRequest<T>(
  token: string,
  path: string,
  options: RequestInit = {},
): Promise<T> {
  // An empty token would be sent as `Bearer ` and answered 401 anyway; refuse it here so
  // no request leaves without credentials. 401 so callers treat it as a token to re-enter.
  if (!token.trim()) throw new DigitalOceanApiError(401, "API token is missing.");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(`https://api.digitalocean.com/v2${path}`, {
      ...options,
      headers: {
        ...options.headers,
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      signal: controller.signal,
    });
    if (res.status === 204) return undefined as T;
    let body: unknown;
    try {
      body = JSON.parse(await res.text());
    } catch {
      throw new DigitalOceanApiError(
        res.ok ? 502 : res.status,
        "The API returned an unreadable response. Try again.",
      );
    }
    if (!res.ok) {
      const message = (body as DigitalOceanErrorBody | null)?.message;
      const detail = typeof message === "string" ? message.slice(0, 500) : "";
      throw new DigitalOceanApiError(
        res.status,
        redact(detail || `Request failed (${res.status}).`, token),
      );
    }
    return body as T;
  } catch (error) {
    if (error instanceof DigitalOceanApiError) throw error;
    throw new DigitalOceanApiError(503, "The API could not be reached. Try again.");
  } finally {
    clearTimeout(timer);
  }
}

/** Every item under `key` across pages. `path` may already carry a query string. */
export async function digitaloceanList<T>(token: string, path: string, key: string): Promise<T[]> {
  const result: T[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const body = await digitaloceanRequest<Record<string, unknown>>(
      token,
      `${path}${path.includes("?") ? "&" : "?"}per_page=${PER_PAGE}&page=${page}`,
    );
    const items = body?.[key];
    if (!Array.isArray(items)) {
      throw new DigitalOceanApiError(502, "The API returned an invalid list.");
    }
    result.push(...(items as T[]));
    const links = body.links as { pages?: { next?: string } } | undefined;
    if (!links?.pages?.next || items.length < PER_PAGE) return result;
  }
  throw new DigitalOceanApiError(502, "Too many results to list.");
}
