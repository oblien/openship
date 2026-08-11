#!/usr/bin/env node
/**
 * Refresh the vendored GeoLite2-Country database.
 *
 * This is the ONLY place an upstream mirror is referenced, and it runs at
 * maintainer/CI time — never on a customer's running server. The committed
 * copy at apps/api/assets/geoip/ is what production ships and reads.
 *
 * Usage:
 *   bun run update:geoip
 *   GEOIP_UPSTREAM_URL=<url> bun run update:geoip   # override the source
 *
 * Commit the resulting file so our copy stays the source of truth.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const UPSTREAM =
  process.env.GEOIP_UPSTREAM_URL?.trim() ||
  "https://raw.githubusercontent.com/P3TERX/GeoLite.mmdb/download/GeoLite2-Country.mmdb";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(repoRoot, "apps", "api", "assets", "geoip", "GeoLite2-Country.mmdb");

console.log(`Fetching GeoLite2-Country from ${UPSTREAM} ...`);
const res = await fetch(UPSTREAM);
if (!res.ok) {
  console.error(`Download failed: HTTP ${res.status}`);
  process.exit(1);
}
const buf = Buffer.from(await res.arrayBuffer());
if (buf.length < 1_000_000) {
  console.error(`Refusing to write a suspiciously small file (${buf.length} bytes)`);
  process.exit(1);
}
await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, buf);
console.log(`Wrote ${OUT} (${(buf.length / 1e6).toFixed(1)} MB). Commit it to update our copy.`);
