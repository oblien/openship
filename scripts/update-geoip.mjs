#!/usr/bin/env node
/** Refresh or check the GeoLite2 snapshot packaged with a release. */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const output = join(root, "apps/api/assets/geoip/GeoLite2-Country.mmdb");
const require = createRequire(join(root, "apps/api/package.json"));
const { Reader } = require("maxmind");
const upstream = "https://raw.githubusercontent.com/P3TERX/GeoLite.mmdb/download/GeoLite2-Country.mmdb";
const day = 86_400_000;

export function inspectGeoip(bytes, now = Date.now()) {
  if (bytes.length < 1_000_000) throw new Error("GeoIP download is smaller than a country database");
  const metadata = new Reader(bytes).metadata;
  if (metadata.databaseType !== "GeoLite2-Country") throw new Error(`Unexpected GeoIP database type: ${metadata.databaseType}`);
  const age = now - metadata.buildEpoch.getTime();
  if (!Number.isFinite(age) || age < -day || age > 14 * day) {
    throw new Error(`GeoIP database build date ${metadata.buildEpoch.toISOString()} is not current. Refresh the source snapshot before publishing.`);
  }
  return {
    databaseType: metadata.databaseType,
    builtAt: metadata.buildEpoch.toISOString(),
    ageDays: Math.floor(age / day),
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length,
  };
}

export async function refreshGeoip(url = process.env.GEOIP_UPSTREAM_URL?.trim() || upstream, destination = output, now = Date.now()) {
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`GeoIP download failed: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const receipt = inspectGeoip(bytes, now);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, bytes);
  return receipt;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const receipt = process.argv.includes("--check")
    ? inspectGeoip(await readFile(output))
    : await refreshGeoip();
  console.log(JSON.stringify(receipt, null, 2));
}
