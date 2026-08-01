import { api, getApiBaseUrl } from "./client";
import { endpoints } from "./endpoints";
import type { ScanProjectResponse } from "./projects";

/**
 * Folder-upload deploy API (SaaS + self-hosted).
 *
 * The client is deliberately DUMB about where the bytes go: the server hands
 * back an opaque `upload` descriptor (url + headers + method), and we just POST
 * the tar.gz there. It doesn't know whether that's an Oblien workspace, this
 * API, or a future object store — the destination is server-owned and can
 * change without touching this file.
 */

/** Opaque upload target — mirror of the server's UploadTarget. */
export interface UploadTarget {
  /** Absolute URL, or an API-relative path resolved against the API base. */
  url: string;
  /** Pre-resolved absolute form, for clients with no API base of their own
   *  (MCP/curl). The browser deliberately keeps using `url` + its own base:
   *  same-origin is what makes the session cookie work. */
  absoluteUrl: string;
  method: "POST";
  headers: Record<string, string>;
  /** Target needs the caller's API credentials (the same-origin relay) — the
   *  browser supplies them via `withCredentials`. */
  requiresAuth: boolean;
  withCredentials: boolean;
}

export interface FolderSession {
  success: boolean;
  sessionId: string;
  expiresAt: number;
  upload: UploadTarget;
}

export type FolderScanResponse = ScanProjectResponse & { sessionId: string };

export const folderApi = {
  /** Open an upload session; server returns an opaque upload target. */
  createSession: (body: { stack?: string; packageManager?: string; name?: string }) =>
    api.post<FolderSession>(endpoints.projects.folderSession, body),

  /** Authoritative framework detection on the uploaded source (fallback path;
   *  the UI normally seeds from the user-picked stack instead). */
  scan: (sessionId: string) =>
    api.post<FolderScanResponse>(endpoints.projects.folderScan(sessionId), {}),

  /** #336: real (unmasked) per-service env for the scan wizard's reveal toggle,
   *  keyed by service name. Write-gated (project:write) on the API. */
  reveal: (sessionId: string) =>
    api.get<{ success: boolean; environments: Record<string, Record<string, string>> }>(
      endpoints.projects.folderEnvReveal(sessionId),
    ),

  /** Upload the gzipped tarball to the session's target. Destination-agnostic. */
  async upload(session: FolderSession, gz: Blob): Promise<void> {
    const { url, method, headers, withCredentials } = session.upload;
    // Absolute URL → use as-is; relative path → resolve against the API base.
    const target = /^https?:\/\//i.test(url)
      ? url
      : `${getApiBaseUrl().replace(/\/$/, "")}/${url.replace(/^\//, "")}`;

    const res = await fetch(target, {
      method,
      headers,
      body: gz,
      credentials: withCredentials ? "include" : "omit",
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`Upload failed (${res.status})${detail ? `: ${detail.slice(0, 200)}` : ""}`);
    }
  },
};
