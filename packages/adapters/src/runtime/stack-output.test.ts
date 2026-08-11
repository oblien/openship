import { describe, expect, test } from "vitest";
import { resolveServedStaticPath, resolveStaticOutputPath } from "./stack-output";

// The result is served / exported as a document root, so it MUST stay inside
// `base`. Covers both callers: bare (base = workDir) and cloud Pages (base = /app).
describe("resolveStaticOutputPath", () => {
  const WORK = "/opt/openship/releases/dep_123";

  test("empty / '.' → base itself", () => {
    expect(resolveStaticOutputPath(WORK, "")).toBe(WORK);
    expect(resolveStaticOutputPath(WORK, ".")).toBe(WORK);
    expect(resolveStaticOutputPath("/app", ".")).toBe("/app"); // #66: not "/app/."
  });

  test("relative subdir → joined under base", () => {
    expect(resolveStaticOutputPath(WORK, "dist")).toBe(`${WORK}/dist`);
    expect(resolveStaticOutputPath("/app", "apps/web/dist")).toBe("/app/apps/web/dist");
  });

  test("trailing slash on base does not double up", () => {
    expect(resolveStaticOutputPath("/app/", "dist")).toBe("/app/dist");
    expect(resolveStaticOutputPath("/app/", ".")).toBe("/app");
  });

  test("absolute outputDirectory is rejected", () => {
    expect(() => resolveStaticOutputPath("/app", "/")).toThrow(/absolute paths are not allowed/);
    expect(() => resolveStaticOutputPath("/app", "/etc")).toThrow(/absolute/);
  });

  test("../ traversal that escapes base is rejected", () => {
    expect(() => resolveStaticOutputPath("/app", "../../etc")).toThrow(/escapes/);
    expect(() => resolveStaticOutputPath(WORK, "dist/../../../root")).toThrow(/escapes/);
  });

  test("../ that stays inside is allowed", () => {
    expect(resolveStaticOutputPath("/app", "build/../dist")).toBe("/app/dist");
  });
});

/**
 * Which directory a routed path serves. Had three copies — deploy-time route
 * registration, the live route re-apply, and the post-deploy output probe — so the
 * vhost could be pointed at one directory while the check auditing it looked at
 * another: a real 404 reading as healthy. One rule now, pinned here.
 */
describe("resolveServedStaticPath", () => {
  const ROOT = "/var/www/openship/site-42";

  test("'/' serves the root itself", () => {
    expect(resolveServedStaticPath(ROOT, "/")).toBe(ROOT);
    expect(resolveServedStaticPath(ROOT, "")).toBe(ROOT);
  });

  test("a subpath serves that directory beneath the root", () => {
    expect(resolveServedStaticPath(ROOT, "/docs")).toBe(`${ROOT}/docs`);
    expect(resolveServedStaticPath(ROOT, "/a/b")).toBe(`${ROOT}/a/b`);
  });

  test("leading slashes and a trailing slash on the root don't double up", () => {
    // The three former copies disagreed here — two used `.slice(1)`, one a
    // `replace(/^\/+/)`. Same answer today, which is exactly how drift hides.
    expect(resolveServedStaticPath(`${ROOT}/`, "/docs")).toBe(`${ROOT}/docs`);
    expect(resolveServedStaticPath(ROOT, "//docs")).toBe(`${ROOT}/docs`);
  });

  test("../ traversal out of the root is rejected", () => {
    // targetPath is operator input from the Domains tab, and the result becomes a
    // public document root. The nginx renderer also refuses traversal; this is the
    // earlier gate, not a replacement for it.
    expect(() => resolveServedStaticPath(ROOT, "/../../etc")).toThrow(/escapes/);
    expect(() => resolveServedStaticPath(ROOT, "/docs/../../../root")).toThrow(/escapes/);
  });

  test("../ that stays inside is allowed", () => {
    expect(resolveServedStaticPath(ROOT, "/docs/../assets")).toBe(`${ROOT}/assets`);
  });
});
