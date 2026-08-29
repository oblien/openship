#!/usr/bin/env node
/**
 * Derive a single representative HUE per country from its flag, for the light-mode
 * choropleth.
 *
 * Why hue only, and why precomputed:
 *
 * In light mode the map used `--primary` (near-black) at stepped opacity, which reads
 * as grey smudges. Tinting each country toward its flag makes it legible AND
 * recognisable — but using the flag's actual colours would produce a clown map, because
 * flags are chosen for contrast against each other, not for sitting side by side in one
 * composition. So we keep only the HUE and impose one saturation and lightness at render
 * time. That is what makes 35 different countries still look like one design.
 *
 * Precomputed because reading 267 SVGs and parsing colours is maintainer-time work, not
 * something to do in a browser on every render. Same reasoning as the vendored world map
 * and the vendored GeoLite2 database.
 *
 * Source: the `country-flag-icons` 3x2 SVGs — the exact same asset the servers list and
 * the map legend render, so a country's tint and its flag can never disagree.
 *
 * Usage:
 *   node scripts/update-country-hues.mjs
 *   FLAG_SVG_DIR=/path/to/3x2 node scripts/update-country-hues.mjs
 *
 * Commit the result.
 */
import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(
  repoRoot, "apps", "dashboard", "src", "components", "monitoring", "country-hues.json",
);

/** Locate the package's 3x2 SVG directory. */
function resolveFlagDir() {
  if (process.env.FLAG_SVG_DIR) return process.env.FLAG_SVG_DIR;
  try {
    const require = createRequire(import.meta.url);
    const pkg = require.resolve("country-flag-icons/package.json", { paths: [repoRoot] });
    const candidate = join(dirname(pkg), "3x2");
    if (existsSync(candidate)) return candidate;
  } catch {
    /* fall through */
  }
  // Bun installs can leave the resolvable entry without the raw SVGs; the global cache
  // keeps a full copy. Checked explicitly so the failure message is actionable.
  const cache = join(
    process.env.HOME ?? "", ".bun", "install", "cache", "country-flag-icons",
  );
  if (existsSync(cache)) {
    for (const v of readdirSync(cache)) {
      const candidate = join(cache, v, "3x2");
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * The handful of CSS NAMED colours these SVGs use instead of hex.
 *
 * Not cosmetic: Canada and Switzerland write `fill="red"`, so a hex-only regex found no
 * chromatic colour in either and both fell through to the neutral tint — the two flags
 * that are almost entirely one vivid colour.
 */
const NAMED = { red: "#ff0000", gold: "#ffd700", green: "#008000", blue: "#0000ff", white: "#ffffff", black: "#000000" };

/** #RGB / #RRGGBB or a supported colour name → {h, s, l} with s/l in 0..100. */
function hexToHsl(input) {
  const named = NAMED[String(input).toLowerCase()];
  let h = (named ?? input).replace("#", "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  if (h.length !== 6) return null;
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l: l * 100 };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let hue;
  if (max === r) hue = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) hue = ((b - r) / d + 2) / 6;
  else hue = ((r - g) / d + 4) / 6;
  return { h: Math.round(hue * 360), s: s * 100, l: l * 100 };
}

const flagDir = resolveFlagDir();
if (!flagDir) {
  console.error(
    "Could not find the country-flag-icons 3x2 SVG directory.\n" +
      "Pass it explicitly: FLAG_SVG_DIR=<path> node scripts/update-country-hues.mjs",
  );
  process.exit(1);
}
console.log(`Reading flag SVGs from ${flagDir} ...`);

// Only the codes the map can actually draw — a hue for a country with no path is dead
// weight in the shipped asset.
const paths = JSON.parse(
  readFileSync(
    join(repoRoot, "apps", "dashboard", "src", "components", "monitoring", "country-paths.json"),
    "utf8",
  ),
).paths;

const hues = {};
const skipped = [];

for (const code of Object.keys(paths)) {
  const file = join(flagDir, `${code}.svg`);
  if (!existsSync(file)) {
    skipped.push(`${code} (no flag)`);
    continue;
  }
  const svg = readFileSync(file, "utf8");

  // Count how often each colour appears. Occurrence is a crude proxy for prominence —
  // a flag's field colour is usually repeated across several paths (stripes, cantons)
  // while an emblem's colours appear once.
  const counts = new Map();
  for (const m of svg.matchAll(/(?:fill|stop-color)\s*=\s*"(#[0-9a-fA-F]{3,6}|[a-zA-Z]+)"/g)) {
    const key = m[1].toLowerCase();
    if (key === "none" || key === "transparent") continue;
    // Skip unrecognised names rather than guessing — a wrong hue is worse than none.
    if (!key.startsWith("#") && !(key in NAMED)) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  let best = null;
  for (const [hex, count] of counts) {
    const hsl = hexToHsl(hex);
    if (!hsl) continue;
    // Drop achromatic colours. White, black and grey carry no hue, and most flags have
    // a lot of white — picking it would give every second country the same dead tint.
    if (hsl.s < 20 || hsl.l > 90 || hsl.l < 10) continue;
    // Rank by saturation × occurrence: prefer a vivid colour, break ties toward the one
    // that covers more of the flag.
    const score = hsl.s * Math.sqrt(count);
    if (!best || score > best.score) best = { score, hue: hsl.h, hex };
  }

  if (!best) {
    // Genuinely achromatic flags (e.g. mostly white/black). Left out so the renderer
    // falls back to the neutral tint rather than inventing a hue.
    skipped.push(`${code} (achromatic)`);
    continue;
  }
  hues[code] = best.hue;
}

const sorted = Object.fromEntries(Object.entries(hues).sort(([a], [b]) => a.localeCompare(b)));
writeFileSync(
  OUT,
  `${JSON.stringify({
    _source: "country-flag-icons 3x2 SVGs — dominant chromatic hue per flag",
    _generatedBy: "scripts/update-country-hues.mjs",
    _note: "Hue only (0-359). Saturation and lightness are imposed at render time so the map reads as one design.",
    hues: sorted,
  })}\n`,
);

console.log(
  `Wrote ${OUT}\n  ${Object.keys(sorted).length} hues` +
    (skipped.length ? `\n  ${skipped.length} skipped: ${skipped.slice(0, 8).join(", ")}${skipped.length > 8 ? " …" : ""}` : ""),
);
