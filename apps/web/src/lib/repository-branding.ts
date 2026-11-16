import { parseOpenshipConfig, type DeploySource } from "@repo/core";

export type RepositoryBranding = { name?: string; logoUrl?: string };
type Repository = Extract<DeploySource, { kind: "repo" }>;
type Entry = { display: RepositoryBranding | null; expiresAt: number; etag?: string };
type FetchFile = (url: string, init: RequestInit) => Promise<Response>;

const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_ENTRIES = 256;
const MAX_PENDING = 8;
const PRESENT_TTL = 30 * 60;
const MISSING_TTL = 5 * 60;

function fileUrl(source: Repository, path: string): string {
  // HEAD follows GitHub's default branch. Encode a named branch as one segment,
  // including branches such as release/v2. Neither host nor credentials are inputs.
  return `https://raw.githubusercontent.com/${source.owner.toLowerCase()}/${source.repo.toLowerCase()}/${encodeURIComponent(source.branch ?? "HEAD")}/${path.split("/").map(encodeURIComponent).join("/")}`;
}

async function readManifest(response: Response): Promise<unknown> {
  if (!response.body) return null;
  if (Number(response.headers.get("content-length")) > MAX_MANIFEST_BYTES) {
    await response.body.cancel();
    return null;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "",
    bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_MANIFEST_BYTES) {
        await reader.cancel();
        return null;
      }
      text += decoder.decode(value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } finally {
    reader.releaseLock();
  }
}

/** Public presentation only. Never uses GitHub credentials or the deployment prepare pipeline. */
export function createRepositoryBrandingLoader({
  fetchFile = (url, init) => fetch(url, init),
  now = Date.now,
}: { fetchFile?: FetchFile; now?: () => number } = {}) {
  // Bounded per-process cache complements the response's CDN/browser caching.
  // Keep only the display projection and ETag, never the manifest or its env values.
  const cache = new Map<string, Entry>();
  const pending = new Map<string, Promise<Entry>>();
  let backoffUntil = 0;
  const entry = (display: RepositoryBranding | null, etag?: string): Entry => ({
    display,
    etag,
    expiresAt: now() + (display ? PRESENT_TTL : MISSING_TTL) * 1000,
  });

  async function refresh(source: Repository, previous?: Entry): Promise<Entry> {
    try {
      const response = await fetchFile(fileUrl(source, "openship.json"), {
        headers: {
          Accept: "application/json",
          ...(previous?.etag ? { "If-None-Match": previous.etag } : {}),
        },
        credentials: "omit",
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.timeout(4_000),
      });
      if (response.status === 304 && previous) return entry(previous.display, previous.etag);
      if (!response.ok) {
        if (response.status === 403 || response.status === 429) {
          const seconds = Number(response.headers.get("retry-after")) || 60;
          backoffUntil = now() + Math.min(3600, Math.max(60, seconds)) * 1000;
        }
        await response.body?.cancel();
        return entry(null);
      }
      const raw = await readManifest(response);
      // Share the manifest validator, but project only presentation fields. Build,
      // environment and service configuration never leave this request or enter the cache.
      const display =
        raw && typeof raw === "object" && !Array.isArray(raw)
          ? parseOpenshipConfig({ display: (raw as Record<string, unknown>).display }).config
              ?.display
          : undefined;
      return entry(
        display
          ? {
              ...(display.name ? { name: display.name } : {}),
              ...(display.logo ? { logoUrl: fileUrl(source, display.logo) } : {}),
            }
          : null,
        response.headers.get("etag") ?? undefined,
      );
    } catch {
      // diagnostics-ignore: optional public branding may be missing, invalid, too large,
      // unavailable or private. Keep the fallback and do not log manifest contents.
      return entry(null);
    }
  }

  return async (
    source: Repository,
  ): Promise<{ display: RepositoryBranding | null; maxAge: number }> => {
    const key = fileUrl(source, "openship.json");
    const previous = cache.get(key);
    let result = previous;
    if (!result || result.expiresAt <= now()) {
      let request = pending.get(key);
      if (!request) {
        if (backoffUntil > now() || pending.size >= MAX_PENDING)
          return { display: null, maxAge: 60 };
        request = refresh(source, previous)
          .then((value) => {
            cache.delete(key);
            if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value!);
            cache.set(key, value);
            return value;
          })
          .finally(() => pending.delete(key));
        pending.set(key, request);
      }
      result = await request;
    } else {
      cache.delete(key);
      cache.set(key, result);
    }
    return {
      display: result.display,
      maxAge: Math.max(0, Math.floor((result.expiresAt - now()) / 1000)),
    };
  };
}

export const getRepositoryBranding = createRepositoryBrandingLoader();
