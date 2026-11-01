import { AppError } from "@repo/core";
export class CloudflareApiError extends AppError {
  constructor(
    public readonly providerStatus: number,
    message: string,
  ) {
    super(`Cloudflare: ${message}`, 502, "CLOUDFLARE_API_ERROR");
  }
}
export interface CloudflareEnvelope<T> {
  success: boolean;
  result: T;
  errors?: Array<{ code: number; message: string }>;
  result_info?: {
    page: number;
    per_page: number;
    count: number;
    total_count: number;
    total_pages: number;
  };
}
/** One bounded transport for DNS, Tunnel and Access. Never include requests or
 * non-JSON bodies in errors: connector tokens are returned as plaintext. */
export async function cloudflareRequest<T>(
  token: string,
  path: string,
  options: RequestInit = {},
): Promise<CloudflareEnvelope<T>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
      ...options,
      headers: {
        ...options.headers,
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      signal: controller.signal,
    });
    let body: CloudflareEnvelope<T>;
    try {
      body = JSON.parse(await res.text());
    } catch {
      throw new CloudflareApiError(
        res.ok ? 502 : res.status,
        "The API returned an unreadable response. Try again.",
      );
    }
    if (!res.ok || body?.success !== true) {
      const detail = body?.errors
        ?.map((e) => (typeof e.message === "string" ? e.message : ""))
        .join(", ")
        .slice(0, 500);
      throw new CloudflareApiError(
        res.status,
        (detail || `Request failed (${res.status}).`).replaceAll(token, "[redacted]"),
      );
    }
    return body;
  } catch (error) {
    if (error instanceof CloudflareApiError) throw error;
    throw new CloudflareApiError(503, "The API could not be reached. Try again.");
  } finally {
    clearTimeout(timer);
  }
}
export async function cloudflareFetch<T>(
  token: string,
  path: string,
  options?: RequestInit,
): Promise<T> {
  return (await cloudflareRequest<T>(token, path, options)).result;
}
export async function cloudflareList<T>(token: string, path: string): Promise<T[]> {
  const result: T[] = [];
  for (let page = 1; page <= 50; page++) {
    const body = await cloudflareRequest<T[]>(
      token,
      `${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`,
    );
    if (!Array.isArray(body.result))
      throw new CloudflareApiError(502, "The API returned an invalid list.");
    result.push(...body.result);
    if (
      body.result.length < 100 ||
      (body.result_info?.total_pages !== undefined && page >= body.result_info.total_pages)
    )
      return result;
  }
  throw new CloudflareApiError(
    502,
    "Too many results. Use a token scoped to the required account.",
  );
}
