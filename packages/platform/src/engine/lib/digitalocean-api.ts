import { AppError } from "@repo/core";
import { safeFetch } from "./safe-fetch";

export class DigitalOceanApiError extends AppError {
  constructor(
    public readonly providerStatus: number,
    message: string,
  ) {
    super(`DigitalOcean: ${message}`, 502, "DIGITALOCEAN_API_ERROR");
  }
}

const PER_PAGE = 200;
const MAX_PAGES = 50;

type RequestOptions = { method?: "GET" | "POST" | "PUT" | "DELETE"; body?: string };

/** Fixed API origin, bounded responses, no redirects or upstream error bodies. */
export async function digitaloceanRequest<T>(
  token: string,
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  if (!token.trim()) throw new DigitalOceanApiError(401, "API token is missing.");
  const url = new URL(`https://api.digitalocean.com/v2${path}`);
  if (
    url.origin !== "https://api.digitalocean.com" ||
    !/^\/v2\/domains(?:\/|$)/.test(url.pathname)
  ) {
    throw new DigitalOceanApiError(400, "Invalid DNS API path.");
  }
  try {
    const res = await safeFetch(url.href, {
      ...options,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      timeoutMs: 15_000,
      maxBodyBytes: 1_000_000,
      maxRedirects: 0,
    });
    if (!res.ok) {
      throw new DigitalOceanApiError(res.status, `Request failed (${res.status}).`);
    }
    if (res.status === 204) return undefined as T;
    try {
      return (await res.json()) as T;
    } catch {
      throw new DigitalOceanApiError(502, "The API returned an unreadable response. Try again.");
    }
  } catch (error) {
    if (error instanceof DigitalOceanApiError) throw error;
    throw new DigitalOceanApiError(503, "The API could not be reached. Try again.");
  }
}

/** Follow page numbers, never URLs supplied by the provider. */
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
    if (!links?.pages?.next) return result;
  }
  throw new DigitalOceanApiError(502, "Too many results to list.");
}
