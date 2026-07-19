/** Validate and canonicalize the single public origin used by a reverse proxy. */
export function normalizePublicUrl(raw?: string): string | undefined {
  if (!raw) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Invalid --public-url: ${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("--public-url must use http:// or https://");
  }
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error(
      "--public-url must be an origin without credentials, a path, query, or fragment",
    );
  }
  return url.origin;
}

/** Add the proxy origin without discarding operator-provided trusted origins. */
export function mergeTrustedOrigin(existing: string | undefined, publicUrl: string): string {
  return [
    ...new Set([
      ...(existing ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
      publicUrl,
    ]),
  ].join(",");
}
