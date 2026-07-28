/**
 * Local cache under ~/.openship/cache. Downloaded desktop-app release assets
 * live at cache/releases/<tag>/<asset> alongside their <asset>.sha256 sidecar,
 * so `install` can skip a re-download and `cache verify` can re-check integrity
 * offline. Downloads and verification stream through node:crypto — release
 * assets are hundreds of MB and must never be buffered whole in memory.
 */
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import { OS_DIR } from "./paths";

export const CACHE_DIR = join(OS_DIR, "cache");
export const RELEASES_DIR = join(CACHE_DIR, "releases");

export function releaseDir(tag: string): string {
  return join(RELEASES_DIR, tag);
}

/** SHA-256 hex of a hex-or-`<hex>  <name>` sidecar body, or null if malformed. */
export function parseSha256(content: string): string | null {
  const token = content.trim().split(/\s+/)[0]?.toLowerCase();
  return token && /^[0-9a-f]{64}$/.test(token) ? token : null;
}

/** Stream a file through SHA-256 without loading it into memory. */
export async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/**
 * Stream `url` to `dest`, hashing bytes as they arrive so the digest is ready
 * the instant the download finishes (no second pass over the file). Returns the
 * hex digest and byte count.
 */
export async function downloadToFile(
  url: string,
  dest: string,
  onProgress?: (received: number, total: number) => void,
): Promise<{ sha256: string; size: number }> {
  const res = await fetch(url, { headers: { "User-Agent": "openship-cli" } });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} for ${url}`);

  mkdirSync(dirname(dest), { recursive: true });
  const total = Number(res.headers.get("content-length")) || 0;
  const hash = createHash("sha256");
  const file = createWriteStream(dest);
  const reader = res.body.getReader();
  let received = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      hash.update(value);
      if (!file.write(Buffer.from(value))) {
        await new Promise<void>((r) => file.once("drain", r));
      }
      received += value.length;
      onProgress?.(received, total);
    }
  } finally {
    file.end();
  }
  await new Promise<void>((resolve, reject) => {
    file.on("finish", () => resolve());
    file.on("error", reject);
  });
  return { sha256: hash.digest("hex"), size: received };
}

/** Human-readable byte size for progress/listing output. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}
