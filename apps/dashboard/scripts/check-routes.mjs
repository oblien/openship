// Route-surface checker: every page/route in `src/app` must exist in a BUILT
// dashboard's route manifest.
//
//   node scripts/check-routes.mjs .next/app-path-routes-manifest.json
//   node scripts/check-routes.mjs /tmp/from-the-image.json
//
// Why this is not redundant with `next build` succeeding: the build compiles
// whatever tree it is handed and emits a manifest that agrees with it, so a page
// LOST BEFORE the build is invisible — no error, no warning, and the manifest
// looks internally consistent. GH-622: `**/build` in .dockerignore removed
// src/app/(dashboard)/(deployment)/build/[id] from the Docker context, and the
// published image shipped 52 routes instead of 53. Every deployment-detail link
// 404'd for two releases' worth of users while CI stayed green.
//
// Run against a manifest extracted from the IMAGE, with a full checkout as the
// source of truth — that comparison is what the truncated context cannot fake.
// (apps/api/test/lib/dockerignore-source-coverage.test.ts guards the specific
// mechanism; this guards the outcome, whatever the cause.)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PAGE_STEMS = new Set(["page", "route"]);
const CODE_EXTS = new Set([".tsx", ".ts", ".jsx", ".js"]);

/** Absolute path to `src/app`, resolved relative to this script. */
export function defaultAppDir() {
  return fileURLToPath(new URL("../src/app", import.meta.url));
}

/**
 * Manifest keys ARE the app-relative path of each page/route file, extension
 * stripped, route groups included — e.g.
 * `/(dashboard)/(deployment)/build/[id]/page`. So the expected set is derived
 * straight from the file tree; no URL-resolution logic and nothing to maintain
 * by hand.
 */
export function expectedRouteKeys(appDir = defaultAppDir()) {
  const keys = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(p);
        continue;
      }
      const ext = path.extname(e.name);
      if (!PAGE_STEMS.has(path.basename(e.name, ext)) || !CODE_EXTS.has(ext)) continue;
      keys.push("/" + path.relative(appDir, p.slice(0, -ext.length)).split(path.sep).join("/"));
    }
  };
  walk(appDir);
  return keys.sort();
}

/** Route keys missing from `manifestPath`. Subset check, not equality: Next adds
 *  synthetic entries (`/_not-found/page`, `/_global-error/page`) that no source
 *  file declares, and an EXTRA route is never the failure we are hunting. */
export function missingRoutes(manifestPath, appDir = defaultAppDir()) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const present = new Set(Object.keys(manifest));
  const expected = expectedRouteKeys(appDir);
  return { expected, total: present.size, missing: expected.filter((k) => !present.has(k)) };
}

if (import.meta.main ?? process.argv[1] === fileURLToPath(import.meta.url)) {
  const manifestPath = process.argv[2];
  if (!manifestPath) {
    console.error("usage: node scripts/check-routes.mjs <app-path-routes-manifest.json>");
    process.exit(2);
  }
  if (!fs.existsSync(manifestPath)) {
    console.error(`route manifest not found: ${manifestPath}`);
    process.exit(2);
  }

  const { expected, total, missing } = missingRoutes(manifestPath);
  console.log(`source pages: ${expected.length}  |  manifest routes: ${total}`);

  if (missing.length) {
    console.error(`\n${missing.length} route(s) in src/app are ABSENT from the build:\n`);
    for (const k of missing) console.error(`  ${k}`);
    console.error(
      "\nThe build did not see these files. Check .dockerignore, the Dockerfile's" +
        " COPY steps, and anything else that filters the build context.",
    );
    process.exit(1);
  }

  console.log("every source page is present in the build.");
}
