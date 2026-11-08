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
import { get as httpGet, type IncomingMessage } from "node:http";
import { get as httpsGet } from "node:https";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

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
  // Node 22's bundled fetch can assert in Parser.finish when a closing peer
  // races body backpressure. Core HTTP streams handle this without Undici's
  // uncaught socket assertion, and pipeline propagates file/network failures.
  let target = new URL(url);
  for (let redirects = 0; redirects <= 5; redirects++) {
    if (target.protocol !== "https:" && target.protocol !== "http:")
      throw new Error(`Unsupported download protocol: ${target.protocol}`);
    const get = target.protocol === "https:" ? httpsGet : httpGet;
    const response = await new Promise<IncomingMessage>((resolve, reject) => {
      get(target, { headers: { "User-Agent": "openship-cli" } }, resolve).once("error", reject);
    });
    const status = response.statusCode ?? 0;
    if ([301, 302, 303, 307, 308].includes(status) && response.headers.location) {
      response.destroy();
      if (redirects === 5) throw new Error("Too many download redirects");
      target = new URL(response.headers.location, target);
      continue;
    }
    if (status < 200 || status >= 300) {
      response.destroy();
      throw new Error(`HTTP ${status} for ${target.origin}${target.pathname}`);
    }
    try { mkdirSync(dirname(dest), { recursive: true }); }
    catch (error) { response.destroy(); throw error; }
    const total = Number(response.headers["content-length"]) || 0;
    const hash = createHash("sha256");
    let received = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        try {
          hash.update(chunk);
          received += chunk.length;
          onProgress?.(received, total);
          callback(null, chunk);
        } catch (error) { callback(error as Error); }
      },
    });
    await pipeline(response, meter, createWriteStream(dest));
    return { sha256: hash.digest("hex"), size: received };
  }
  throw new Error("Too many download redirects");
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
