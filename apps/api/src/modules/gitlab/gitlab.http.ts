/**
 * @module gitlab.http
 *
 * GitLab REST API v4 HTTP primitive. Token resolution lives in gitlab.token /
 * gitlab.auth — this file only issues requests. Callers may override the
 * instance origin for per-user self-hosted PATs; otherwise GITLAB_BASE_URL.
 */

import { env } from "../../config/env";

export interface GlRequest {
  path: string;
  method?: string;
  params?: Record<string, unknown>;
  headers?: Record<string, string>;
  /** Override instance origin (self-hosted per-user PAT). */
  baseUrl?: string;
}

const GL_FETCH_TIMEOUT_MS = 20_000;

/**
 * Normalize a user- or env-supplied GitLab origin to `scheme://host` (no path).
 * Accepts bare hosts (`gitlab.example.com`) and strips trailing slashes.
 * Does NOT apply CLOUD_MODE SSRF policy — call {@link assertAllowedGitlabBaseUrl}
 * before fetching a user-supplied origin.
 */
export function normalizeGitlabBaseUrl(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  try {
    const withProto = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    const u = new URL(withProto);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (!u.hostname) return null;
    return u.origin;
  } catch {
    return null;
  }
}

/** Instance-wide GitLab origin from env (default https://gitlab.com). */
export function configuredGitlabOrigin(): string {
  return normalizeGitlabBaseUrl(env.GITLAB_BASE_URL) ?? "https://gitlab.com";
}

/**
 * CLOUD_MODE SSRF guard for user-supplied GitLab origins.
 *
 * On the multi-tenant SaaS, connect() fetches `baseUrl` with a Bearer token
 * before saving — a custom host is a classic SSRF. Refuse anything other than
 * the configured public origin (HTTPS). Self-hosted operators may point at
 * their own GitLab (http + private hosts allowed).
 */
export function assertAllowedGitlabBaseUrl(origin: string): void {
  let u: URL;
  try {
    u = new URL(origin);
  } catch {
    throw new Error("Invalid GitLab URL");
  }

  if (!env.CLOUD_MODE) {
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      throw new Error("GitLab URL must use http or https");
    }
    return;
  }

  if (u.protocol !== "https:") {
    throw new Error("GitLab URL must use HTTPS");
  }

  const allowed = configuredGitlabOrigin();
  if (u.origin !== allowed) {
    throw new Error(
      `Custom GitLab URLs are not allowed on Openship Cloud. Use ${allowed} or connect OAuth.`,
    );
  }
}

/**
 * Normalize + apply SSRF policy. Returns null when the input is empty/malformed;
 * throws when the origin is well-formed but disallowed (CLOUD_MODE).
 */
export function parseAllowedGitlabBaseUrl(input: string): string | null {
  const normalized = normalizeGitlabBaseUrl(input);
  if (!normalized) return null;
  assertAllowedGitlabBaseUrl(normalized);
  return normalized;
}

export function gitlabWebBase(baseUrl?: string | null): string {
  if (baseUrl) {
    const normalized = normalizeGitlabBaseUrl(baseUrl);
    if (normalized) {
      // Defense in depth: never fetch a disallowed origin even if a stale
      // row slipped into user_settings before the CLOUD_MODE guard existed.
      try {
        assertAllowedGitlabBaseUrl(normalized);
        return normalized;
      } catch {
        /* fall through to configured origin */
      }
    }
  }
  return configuredGitlabOrigin();
}

export function gitlabApiBase(baseUrl?: string | null): string {
  return `${gitlabWebBase(baseUrl)}/api/v4`;
}

function withQuery(url: string, method: string, params?: Record<string, unknown>): string {
  if (method !== "GET" || !params) return url;
  const entries: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    entries[k] = String(v);
  }
  const qs = new URLSearchParams(entries).toString();
  return qs ? `${url}?${qs}` : url;
}

async function timedFetch(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GL_FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function glFetch<T = unknown>(token: string, req: GlRequest): Promise<T> {
  const method = req.method ?? "GET";
  const url = withQuery(`${gitlabApiBase(req.baseUrl)}${req.path}`, method, req.params);
  const res = await timedFetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(req.headers ?? {}),
    },
    body: method !== "GET" ? JSON.stringify(req.params ?? {}) : undefined,
  });

  if (res.status === 204) return { success: true } as T;

  const data = (await res.json().catch(() => ({}))) as T & {
    message?: string;
    error?: string;
  };
  if (!res.ok) {
    const msg =
      (data as { message?: string }).message ??
      (data as { error?: string }).error ??
      "Unknown";
    throw new Error(`GitLab API error (${res.status}): ${msg}`);
  }
  return data;
}

/** Soft variant — returns null on any failure. */
export async function glFetchSoft<T = unknown>(
  token: string,
  req: GlRequest,
): Promise<T | null> {
  try {
    return await glFetch<T>(token, req);
  } catch {
    return null;
  }
}

/** Public project probe (no token). Returns true when visibility is public. */
export async function isPublicGitlabProject(
  projectId: number,
  baseUrl?: string | null,
): Promise<boolean> {
  try {
    const res = await timedFetch(`${gitlabApiBase(baseUrl)}/projects/${projectId}`, {
      method: "GET",
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return false;
    const data = (await res.json()) as { visibility?: string };
    return data.visibility === "public";
  } catch {
    return false;
  }
}
