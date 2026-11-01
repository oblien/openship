import { ApiError } from "./errors";
import { parseSSE, type SSEEvent } from "./events";

/** Provider-issued stream credentials are isolated from instance bearer/cookie auth. */
export async function* streamWithToken(
  target: { url: string; token: string },
  fetcher: typeof globalThis.fetch,
  options: { signal?: AbortSignal } = {},
): AsyncGenerator<SSEEvent> {
  options.signal?.throwIfAborted();
  let url: URL;
  try { url = new URL(target.url); }
  catch { throw new ApiError("Invalid request-log stream URL", 502, null); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash)
    throw new ApiError("Invalid request-log stream URL", 502, null);
  if (!target.token) throw new ApiError("Missing request-log stream token", 502, null);
  url.searchParams.set("token", target.token);
  let response: Response;
  try {
    response = await fetcher(url.href, {
      headers: { Accept: "text/event-stream" },
      credentials: "omit", redirect: "error", signal: options.signal,
    });
  } catch {
    options.signal?.throwIfAborted();
    // Transport errors (including custom fetch implementations) can contain the
    // complete signed URL. Preserve cancellation, but never expose that error.
    throw new ApiError("Could not connect to the request-log stream", 502, null);
  }
  if (!response.ok || !response.headers.get("content-type")?.includes("text/event-stream")) {
    await response.body?.cancel().catch(() => { /* diagnostics-ignore: Ignore body cancellation after a failure; the caller receives a sanitized error without the signed URL. */ return undefined; });
    // Never include the signed URL or an upstream error body that may echo it.
    throw new ApiError("Request-log stream is unavailable", response.ok ? 502 : response.status, null);
  }
  if (!response.body) throw new ApiError("Request-log stream has no body", 502, null);
  try { yield* parseSSE(response.body); }
  catch {
    options.signal?.throwIfAborted();
    throw new ApiError("Request-log stream disconnected", 502, null);
  }
}
