/**
 * @module gitlab.http
 *
 * GitLab REST API v4 HTTP primitive. Token resolution lives in gitlab.token /
 * gitlab.auth — this file only issues requests against GITLAB_BASE_URL.
 */

import { env } from "../../config/env";

export interface GlRequest {
  path: string;
  method?: string;
  params?: Record<string, unknown>;
  headers?: Record<string, string>;
}

const GL_FETCH_TIMEOUT_MS = 20_000;

export function gitlabApiBase(): string {
  return `${env.GITLAB_BASE_URL.replace(/\/$/, "")}/api/v4`;
}

export function gitlabWebBase(): string {
  return env.GITLAB_BASE_URL.replace(/\/$/, "");
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
  const url = withQuery(`${gitlabApiBase()}${req.path}`, method, req.params);
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
export async function isPublicGitlabProject(projectId: number): Promise<boolean> {
  try {
    const res = await timedFetch(`${gitlabApiBase()}/projects/${projectId}`, {
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
