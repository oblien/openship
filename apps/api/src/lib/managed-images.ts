import { createHash } from "node:crypto";
import { type Dirent, existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";

import { apiRootPath } from "./release-resolver";

/**
 * The from-source BUILD context for a managed-container image (the edge, the mail
 * engine), or undefined when there's no checkout on this API's disk to build from.
 * Consumed by {@link ../deliver-managed-image}, which builds the component's
 * Dockerfile ON THE TARGET box (in place when the checkout is there, else ship the
 * source + build) in place of the target pulling an (often unpublished) tag. Its
 * presence is also what switches `pinned*Image()` onto the content-derived dev tag
 * (see devSourceTag).
 *
 * ONE detector for every managed image, so the build-vs-pull switch lives in a
 * single place: as more managed containers arrive they get an `xBuildSpec()` that is
 * just a call here, not another hand-rolled env+anchor+existsSync trio that can drift.
 *
 * SECURITY: the value returned is fed to `docker build`, which runs the Dockerfile's
 * RUN steps as ROOT. It is therefore SERVER-DERIVED ONLY — either the explicit env
 * override or this API's own on-disk anchor — NEVER placed on InstallerConfig or read
 * from any request body. Same boundary as `withPinnedEdgeImage`.
 *
 *   1. `envVar` — an explicit repo root.
 *   2. Auto: the repo root above this API package, via the single on-disk anchor
 *      ({@link apiRootPath}) rather than a second `import.meta.url` derivation. Guarded
 *      by the Dockerfile existing there, so a compiled binary or a bundled install —
 *      where that anchor points nowhere useful — returns undefined and bring-up falls
 *      through to the registry pull.
 *
 * The tag is unaffected — it stays driven by the component's `pinned*Image()`, so a
 * built image carries exactly the ref bring-up resolves.
 */
export function detectBuildContext(
  dockerfile: string,
  envVar: string,
): { context: string; dockerfile: string } | undefined {
  const explicit = process.env[envVar]?.trim();
  if (explicit) return { context: explicit, dockerfile };

  const repoRoot = apiRootPath("..", "..");
  return existsSync(join(repoRoot, dockerfile)) ? { context: repoRoot, dockerfile } : undefined;
}

// Generated / vendored trees whose contents are not "the code I just changed":
// hashing them would move the dev tag on `pnpm install` or a stray build artifact,
// not on a source edit — the opposite of what the drift simulation wants.
const SIGNATURE_SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  ".next",
  ".turbo",
  ".cache",
]);

/** Recursively collect `relpath|size|mtimeMs` lines for the source files under `dir`. */
function statSignature(dir: string): string[] {
  const lines: string[] = [];
  const walk = (abs: string) => {
    let entries: Dirent[];
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      return; // unreadable dir → contributes nothing rather than throwing the scan
    }
    for (const entry of entries) {
      if (entry.name === ".DS_Store") continue;
      const child = join(abs, entry.name);
      if (entry.isDirectory()) {
        if (SIGNATURE_SKIP_DIRS.has(entry.name)) continue;
        walk(child);
      } else if (entry.isFile()) {
        try {
          const st = statSync(child);
          lines.push(`${relative(dir, child)}|${st.size}|${st.mtimeMs}`);
        } catch {
          // Raced away between readdir and stat — skip it.
        }
      }
    }
  };
  walk(dir);
  return lines;
}

// A short TTL, not a permanent memo: the apps/api dev watcher does NOT restart the
// process when apps/edge or apps/email change (they're sibling apps), so a
// process-lifetime cache would make the drift scan blind to edits in exactly the
// trees this tag is meant to track. The TTL keeps a multi-server scan burst cheap
// (one hash per component per ~window) while still surfacing a source edit within
// seconds — which is all the "simulate a prod mismatch" flow needs.
const DEV_TAG_TTL_MS = 2000;
const devTagCache = new Map<string, { at: number; tag: string | undefined }>();

/**
 * A content-derived "virtual version" for a managed component in a source checkout:
 * `<baseVersion>-dev.<hash>` where the hash tracks the component's source tree
 * (`<buildContext>/<componentSubdir>`, e.g. apps/edge). Undefined when the tree is
 * absent/empty — the caller then falls back to the plain published version.
 *
 * This is the CHECK half of the two-stage model: the drift scan compares a running
 * container's tag to `pinned*Image()`, so folding this suffix in makes a manual edit
 * to apps/edge move the tag → the scan reports the box "behind" → an install/update
 * rebuilds from source. The tag is UNPUBLISHED, so it can only ever be satisfied by a
 * from-source build, never a stale registry pull. In a compiled/prod install there is
 * no checkout, so callers never reach here and the plain version is used.
 *
 * The signature is stat-based (path+size+mtime), not a content hash: it only needs to
 * change when a file is touched, which is exactly a manual code edit in dev.
 */
export function devSourceTag(
  baseVersion: string,
  buildContext: string,
  componentSubdir: string,
): string | undefined {
  const dir = join(buildContext, componentSubdir);
  const now = Date.now();
  const cached = devTagCache.get(dir);
  if (cached && now - cached.at < DEV_TAG_TTL_MS) return cached.tag;

  const lines = statSignature(dir);
  const tag = lines.length
    ? `${baseVersion}-dev.${createHash("sha256").update(lines.sort().join("\n")).digest("hex").slice(0, 12)}`
    : undefined;
  devTagCache.set(dir, { at: now, tag });
  return tag;
}

/**
 * The tag a managed component's `pinned*Image()` should fall back to: the
 * content-derived dev tag when a build spec (checkout) is present, else the plain
 * `baseVersion`. Shared by the edge + mail pins so the "spec ⇒ dev tag, else version"
 * rule lives in one place. The component subdir is `dirname(spec.dockerfile)` (e.g.
 * apps/edge), so the hash tracks exactly that component's source tree.
 */
export function devFallbackTag(
  baseVersion: string,
  spec?: { context: string; dockerfile: string },
): string {
  if (!spec) return baseVersion;
  return devSourceTag(baseVersion, spec.context, dirname(spec.dockerfile)) ?? baseVersion;
}
