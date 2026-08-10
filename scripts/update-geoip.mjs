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
import { createHash } from "node:crypto";
import { createRequire } from "node:module";

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

/*
 * PARSE it before trusting it.
 *
 * A size floor only catches a 404 page. It does not catch a truncated transfer, a
 * redirect to something else of plausible size, or an upstream that changed what it
 * publishes at this path — and the upstream here is a moving BRANCH (`download`), not a
 * tagged release, so what it serves can change without notice.
 *
 * Getting that wrong is expensive and quiet: the bad file is committed, baked into the edge
 * image, and every visitor's country silently becomes unknown. `geo_country.lua` reports
 * `available: false` rather than crashing, so the only symptom is an empty map.
 *
 * `mmdb-lib`'s parser reads the whole header, so a structurally broken file throws here
 * instead of shipping. It is already a dependency (the API's own lookups use it).
 */
// Resolved through apps/api, which owns the dependency — the same createRequire trick
// update-country-hues.mjs uses. The repo root has no node_modules of its own to find it in.
const require_ = createRequire(join(repoRoot, "apps", "api", "package.json"));
const { Reader } = require_("maxmind");
let meta;
try {
  // Constructing a Reader parses the header; a structurally broken file throws right here
  // instead of being committed and baked into the edge image.
  meta = new Reader(buf).metadata;
} catch (err) {
  console.error(`Refusing to write: not a parseable MMDB (${err?.message ?? err})`);
  process.exit(1);
}
if (meta.databaseType !== "GeoLite2-Country") {
  // Country-only on purpose: it is 8 MB against ~60 MB for City, and a country code is all
  // the analytics ever reads.
  console.error(`Refusing to write: expected GeoLite2-Country, got "${meta.databaseType}"`);
  process.exit(1);
}

await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, buf);

// Provenance, because the upstream is an unversioned branch. The commit pins the BYTES;
// this is what tells a reader (and the release notes) how old those bytes are. GeoLite2
// accuracy degrades with age, so a stale build is a real, invisible quality loss.
const built = meta.buildEpoch;
const ageDays = Math.floor((Date.now() - built.getTime()) / 86_400_000);
console.log(
  `Wrote ${OUT} (${(buf.length / 1e6).toFixed(1)} MB)\n` +
    `  type:  ${meta.databaseType}  ipVersion=${meta.ipVersion}  nodes=${meta.nodeCount}\n` +
    `  built: ${built.toISOString().slice(0, 10)} (${ageDays} days old)\n` +
    `  sha256: ${createHash("sha256").update(buf).digest("hex")}\n` +
    `  Commit it to update our copy.`,
);
if (ageDays > 60) {
  console.warn(
    `  WARNING: this build is ${ageDays} days old. MaxMind publishes weekly; the mirror may be stale.`,
  );
}
