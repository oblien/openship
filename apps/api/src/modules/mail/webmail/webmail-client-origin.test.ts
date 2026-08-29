/**
 * The webmail client must never learn its own origin at build time.
 *
 * GH-567: every route guard in the Zero client built its redirect by
 * interpolating `import.meta.env.VITE_PUBLIC_APP_URL` -
 *
 *     if (!session) return Response.redirect(`${import.meta.env.VITE_PUBLIC_APP_URL}/login`);
 *
 * - so the published image froze whatever the BUILD host defined into the
 * bundle. `ghcr.io/oblien/openship-webmail:latest` shipped
 * `http://localhost:3000/login`; a build with the var unset ships the literal
 * string `"undefined/login"`. On any real hostname a session expiry threw the
 * user clean off their own domain, and no runtime env could correct it - the
 * value was a constant in minified JavaScript.
 *
 * Two bans, both narrow and both load-bearing:
 *
 *   VITE_PUBLIC_APP_URL - the app's own origin is not a build-time fact. It is
 *     `window.location.origin`, always: the Hono server serves the SPA and the
 *     API on one port (client/lib/backend-url.ts documents that invariant).
 *
 *   Response.redirect - per the Fetch spec this REQUIRES an absolute URL, so
 *     reaching for it in a route loader is what forces an origin into the
 *     picture at all. `redirect()` from react-router takes a relative path and
 *     the router resolves it against the live origin, basename included.
 *
 * Why this test lives in apps/api rather than apps/email: `turbo run test`
 * only runs packages that declare a test script, and apps/email declares none
 * - so a test placed there would never run on a pull request. Its sibling
 * webmail-catalog-contract.test.ts already asserts cross-boundary webmail
 * facts from here for the same reason. The release build carries the matching
 * OUTPUT check (apps/email/scripts/build-release.ts scans the built bundle for
 * baked dev origins, so neither the image nor the tarball can publish one);
 * this is the copy that fails on the PR that introduces it.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Walk up from this file to the repo root - the directory that contains the
 * webmail client. Resolved by marker rather than by a fixed `../../../..`
 * count so moving this test doesn't silently turn it into a no-op.
 */
function findClientRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 10; i++) {
    const candidate = join(dir, "apps", "email", "client");
    if (existsSync(join(candidate, "react-router.config.ts"))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("apps/email/client not found - fix the marker walk in this test");
}

const CLIENT = findClientRoot();

// The hand-written source. Everything else under client/ is generated or
// vendored: build/ (Vite output), paraglide/ (i18n codegen), .react-router/
// (route typegen), node_modules/.
const SOURCE_DIRS = ["app", "components", "lib", "hooks", "providers", "store", "utils"];
const SOURCE_EXTENSIONS = [".ts", ".tsx"];

function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules") continue;
        walk(path);
      } else if (SOURCE_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) {
        out.push(path);
      }
    }
  };
  for (const dir of SOURCE_DIRS) walk(join(CLIENT, dir));
  return out;
}

const FILES = sourceFiles().map((path) => ({
  path: relative(CLIENT, path),
  text: readFileSync(path, "utf-8"),
}));

describe("webmail client origin (GH-567)", () => {
  it("has source to check", () => {
    // A broken walk would make every assertion below vacuously pass.
    expect(FILES.length).toBeGreaterThan(100);
  });

  it("never reads its own origin from the build env", () => {
    const offenders = FILES.filter((f) => f.text.includes("VITE_PUBLIC_APP_URL")).map(
      (f) => f.path,
    );
    expect(
      offenders,
      "The app's origin is window.location.origin at runtime, never a build-time env " +
        "var (see client/lib/backend-url.ts). Use a relative redirect instead.",
    ).toEqual([]);
  });

  it("never uses Response.redirect, which forces an absolute URL", () => {
    const offenders = FILES.filter((f) => /\bResponse\.redirect\s*\(/.test(f.text)).map(
      (f) => f.path,
    );
    expect(
      offenders,
      "Response.redirect() requires an absolute URL. Use react-router's " +
        "`replace('/path')` (auth guards and index bounces, so the bounced URL does " +
        "not linger in history) or `redirect('/path')` - both resolve relative to the " +
        "live origin and basename.",
    ).toEqual([]);
  });
});
