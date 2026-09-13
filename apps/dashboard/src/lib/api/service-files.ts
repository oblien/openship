/**
 * Service files API client — read-only browsing inside a deployed container.
 *
 * Sibling of service-terminal.ts and gated identically server-side (project
 * admin): a container's filesystem holds its `.env`, so this is the same reach
 * as a shell, not a lesser one.
 *
 * Paths are always the ones the SERVER returned (`entry.path`), never built by
 * concatenating strings here — normalization lives in exactly one place so a
 * name like `..` can't become a client-side traversal.
 */

import { api, getApiBaseUrl } from "./client";
import { endpoints } from "./endpoints";

export interface ServiceFileEntry {
  name: string;
  /** RESOLVED type — a symlink reports what it points AT, so a symlinked
   *  directory (`storage`, `current`, …) is navigable rather than a dead end. */
  type: "file" | "dir";
  /** True when the entry itself is a symlink, whatever it resolves to. */
  symlink: boolean;
  /** Bytes for regular files; 0 for directories. */
  size: number;
  /** Canonical absolute path inside the container, resolved server-side. */
  path: string;
}

export interface ServiceFileListing {
  success: true;
  /** The canonical form of the directory actually listed. */
  path: string;
  /** The directory holds more than `limit` entries and was cut short. Surfaced
   *  so the UI can say so — a capped listing that looked complete would report
   *  500 files in a directory holding 40,000. */
  truncated: boolean;
  limit: number;
  entries: ServiceFileEntry[];
}

export type ServiceFileContent =
  | { success: true; path: string; binary: false; size: number; content: string }
  | { success: true; path: string; binary: true; size: number; content: null };

export function listServiceFiles(
  serviceId: string,
  path: string,
): Promise<ServiceFileListing> {
  return api.get<ServiceFileListing>(endpoints.serviceFiles.list(serviceId, path));
}

export function readServiceFile(
  serviceId: string,
  path: string,
): Promise<ServiceFileContent> {
  return api.get<ServiceFileContent>(endpoints.serviceFiles.read(serviceId, path));
}

/**
 * Download a file to disk.
 *
 * Deliberately NOT a plain `<a href>`: the endpoint answers 413 (over the cap),
 * 404 (deleted since listing) or 403 with a JSON body and no
 * Content-Disposition, and a top-level navigation would replace the dashboard
 * with a raw `{"error":…}` page. Fetching lets a failure stay an in-place
 * message. Bounded by the server's 10MB cap, so buffering a blob is safe.
 *
 * Throws with the server's message on failure.
 */
export async function downloadServiceFile(
  serviceId: string,
  path: string,
  filename: string,
): Promise<void> {
  const url = new URL(endpoints.serviceFiles.download(serviceId, path), getApiBaseUrl()).toString();
  const res = await fetch(url, { credentials: "include" });

  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(
      (body as { error?: string } | null)?.error ?? `Download failed (${res.status})`,
    );
  }

  const blob = await res.blob();
  const objectUrl = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    // Revoke on the next tick — revoking synchronously can cancel the download
    // in some browsers before it has read the blob.
    setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
  }
}
