/**
 * Container-registry digest lookup — the image analog of release-dist.ts's
 * `resolveLatestVersion` (GitHub releases). Given an image ref pinned to a
 * MUTABLE tag (`n8nio/n8n:latest`, `gitea/gitea:1`), resolve the CURRENT content
 * digest the tag points at, so the update scanner can compare it against the
 * digest actually running (captured at deploy) and detect a moved tag.
 *
 * Uses the Docker Registry HTTP v2 API: a `HEAD /v2/<repo>/manifests/<ref>`
 * returns the `Docker-Content-Digest` header (the digest `docker pull` would
 * resolve to). Anonymous pulls need a bearer token — the registry answers 401
 * with a `WWW-Authenticate: Bearer realm=…,service=…,scope=…` challenge, we
 * fetch the token from that realm, then retry. Public images (all curated app
 * templates) work anonymously; PRIVATE/unknown registries fail SOFT → null
 * ("no update info"), never throwing and never blocking a scan.
 *
 * Results are cached in-memory for a few minutes (registry rate limits).
 */

import { env } from "../config/env";
import { safeFetch, type SafeFetchResponse } from "./safe-fetch";

interface ParsedRef {
  registry: string; // API host, e.g. "registry-1.docker.io", "ghcr.io"
  repo: string; // e.g. "library/mysql", "n8nio/n8n", "get-convex/convex-backend"
  ref: string; // tag or digest, e.g. "latest", "1", "sha256:…"
}

const DEFAULT_REGISTRY = "registry-1.docker.io";
const CACHE_TTL_MS = 5 * 60_000;
const cache = new Map<string, { digest: string | null; at: number }>();

const MANIFEST_ACCEPT = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

/**
 * Parse a docker image reference into { registry, repo, ref }. Mirrors docker's
 * normalization: a first path segment containing "." or ":" (or "localhost") is
 * the registry host; otherwise it's Docker Hub, and a single-segment repo gets
 * the implicit `library/` prefix.
 */
export function parseImageRef(image: string): ParsedRef | null {
  const trimmed = image.trim();
  if (!trimmed) return null;

  // Split off a digest or tag from the end. A "@" always separates a digest.
  let remainder = trimmed;
  let ref = "latest";
  const atIdx = remainder.indexOf("@");
  if (atIdx >= 0) {
    ref = remainder.slice(atIdx + 1);
    remainder = remainder.slice(0, atIdx);
  } else {
    // A colon AFTER the last slash is a tag (a colon before is a registry port).
    const lastColon = remainder.lastIndexOf(":");
    const lastSlash = remainder.lastIndexOf("/");
    if (lastColon > lastSlash) {
      ref = remainder.slice(lastColon + 1);
      remainder = remainder.slice(0, lastColon);
    }
  }

  const firstSlash = remainder.indexOf("/");
  const firstSegment = firstSlash >= 0 ? remainder.slice(0, firstSlash) : "";
  const hasRegistry =
    firstSegment.includes(".") || firstSegment.includes(":") || firstSegment === "localhost";

  if (hasRegistry) {
    return { registry: firstSegment, repo: remainder.slice(firstSlash + 1), ref };
  }
  // Docker Hub: single-name official images live under library/.
  const repo = remainder.includes("/") ? remainder : `library/${remainder}`;
  return { registry: DEFAULT_REGISTRY, repo, ref };
}

async function fetchToken(challenge: string): Promise<string | null> {
  // WWW-Authenticate: Bearer realm="https://auth.docker.io/token",service="…",scope="…"
  const m = /Bearer (.+)/i.exec(challenge);
  if (!m) return null;
  const params: Record<string, string> = {};
  for (const part of m[1].split(",")) {
    const kv = /^\s*([a-z_]+)="?([^"]*)"?\s*$/i.exec(part);
    if (kv) params[kv[1]] = kv[2];
  }
  const realm = params.realm;
  if (!realm) return null;
  const url = new URL(realm);
  if (url.protocol !== "https:") return null;
  if (params.service) url.searchParams.set("service", params.service);
  if (params.scope) url.searchParams.set("scope", params.scope);
  try {
    // SSRF-safe: the token `realm` is attacker-influenced (registry's 401
    // challenge). safeFetch pins the resolved IP; CLOUD_MODE rejects internal
    // targets while self-hosted may use a LAN registry.
    const res = await safeFetch(url.toString(), {
      headers: { "User-Agent": "openship" },
      timeoutMs: 10_000,
      allowPrivate: !env.CLOUD_MODE,
      maxRedirects: 3,
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { token?: string; access_token?: string };
    return body.token ?? body.access_token ?? null;
  } catch {
    return null;
  }
}

async function headManifest(
  registry: string,
  repo: string,
  ref: string,
  token?: string,
): Promise<SafeFetchResponse | null> {
  try {
    // SSRF-safe: `registry` is derived from a user's image ref. safeFetch pins the
    // resolved IP; CLOUD_MODE rejects internal/metadata registries (→ caught → null
    // = "no update info"), self-hosted may use a LAN registry.
    return await safeFetch(`https://${registry}/v2/${repo}/manifests/${encodeURIComponent(ref)}`, {
      method: "HEAD",
      headers: {
        Accept: MANIFEST_ACCEPT,
        "User-Agent": "openship",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      timeoutMs: 10_000,
      allowPrivate: !env.CLOUD_MODE,
      maxRedirects: 3,
    });
  } catch {
    return null;
  }
}

/**
 * Resolve the current content digest (`sha256:…`) a mutable image tag points at.
 * Returns null on ANY failure (unknown/private registry, network, auth, rate
 * limit) — the caller treats null as "no update info" and never blocks.
 */
export async function resolveLatestImageDigest(image: string): Promise<string | null> {
  const cached = cache.get(image);
  // Note: cache read uses the wall clock; callers pass real images, and a stale
  // few-minute entry is acceptable for a background scan.
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.digest;

  const digest = await resolveUncached(image);
  cache.set(image, { digest, at: Date.now() });
  return digest;
}

async function resolveUncached(image: string): Promise<string | null> {
  const parsed = parseImageRef(image);
  if (!parsed) return null;
  const { registry, repo, ref } = parsed;

  // First try anonymous; a public registry answers 401 with a token challenge.
  let res = await headManifest(registry, repo, ref);
  if (res && res.status === 401) {
    const token = await fetchToken(res.headers["www-authenticate"] ?? "");
    if (!token) return null;
    res = await headManifest(registry, repo, ref, token);
  }
  if (!res || !res.ok) return null;
  const digest = res.headers["docker-content-digest"];
  return digest && digest.startsWith("sha256:") ? digest : null;
}
