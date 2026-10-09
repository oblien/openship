#!/usr/bin/env node
/**
 * Copy static assets into the build output so the bundled API ships them.
 * Currently: the vendored GeoLite2 DB (assets/geoip) → dist/assets/geoip, which
 * geo-ip.ts resolves relative to the bundle at runtime.
 */
import { cp, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { stageActionRunnerAssets } from "../../../packages/actions-runner/assets.mjs";

stageActionRunnerAssets("dist/assets/actions-runner");

const src = "assets";
const dest = "dist/assets";

if (!existsSync(src)) {
  console.log("no assets/ dir — nothing to copy");
  process.exit(0);
}
await mkdir("dist", { recursive: true });
await cp(src, dest, { recursive: true });
console.log(`copied ${src} → ${dest}`);
