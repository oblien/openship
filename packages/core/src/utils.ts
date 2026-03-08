/**
 * Shared utility functions.
 */

import { randomBytes } from "node:crypto";

/** Generate a URL-safe slug from a string */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .replace(/[\s_]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100);
}

/** Generate a prefixed unique ID (e.g. "proj_abc123...") */
export function generateId(prefix?: string): string {
  const id = randomBytes(12).toString("base64url");
  return prefix ? `${prefix}_${id}` : id;
}

/** Format bytes to human-readable string */
export function formatBytes(bytes: number, decimals = 2): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(decimals))} ${sizes[i]}`;
}

/** Format duration in seconds to human-readable string */
export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

/** Sleep for a given number of milliseconds */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
