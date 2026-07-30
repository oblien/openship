import { describe, expect, test } from "vitest";
import { resolveStaticOutputPath } from "./stack-output";

// C3 — this result becomes OpenResty's `root <dir>;`. It MUST stay inside the
// deployment workDir; an absolute or ../-traversing outputDirectory would point
// the document root at the host filesystem (arbitrary file disclosure).
//
// Tested on `resolveStaticOutputPath` directly: it is the ONE implementation.
// `BareRuntime.resolveStaticRoot` used to be a two-line passthrough to it, and the
// build pipeline reached the same computation through the method while the output
// check called the helper — two entry points to one guard is how a guard
// eventually gets bypassed, so the method was removed.
describe("resolveStaticOutputPath confinement", () => {
  const WORK = "/opt/openship/releases/dep_123";

  test("empty / '.' → the workDir itself", () => {
    expect(resolveStaticOutputPath(WORK, "")).toBe(WORK);
    expect(resolveStaticOutputPath(WORK, ".")).toBe(WORK);
  });

  test("relative subdir → joined under workDir", () => {
    expect(resolveStaticOutputPath(WORK, "dist")).toBe(`${WORK}/dist`);
    expect(resolveStaticOutputPath(WORK, "apps/web/dist")).toBe(`${WORK}/apps/web/dist`);
  });

  test("absolute path is rejected", () => {
    expect(() => resolveStaticOutputPath(WORK, "/")).toThrow(/absolute paths are not allowed/);
    expect(() => resolveStaticOutputPath(WORK, "/etc")).toThrow(/absolute paths are not allowed/);
    expect(() => resolveStaticOutputPath(WORK, "/etc/letsencrypt/live")).toThrow(/absolute/);
  });

  test("../ traversal that escapes the workDir is rejected", () => {
    expect(() => resolveStaticOutputPath(WORK, "../../../../etc")).toThrow(/escapes/);
    expect(() => resolveStaticOutputPath(WORK, "dist/../../../root")).toThrow(/escapes/);
  });

  test("../ that stays inside is allowed", () => {
    expect(resolveStaticOutputPath(WORK, "build/../dist")).toBe(`${WORK}/dist`);
  });

  test("a trailing slash on the base doesn't double up", () => {
    expect(resolveStaticOutputPath(`${WORK}/`, "dist")).toBe(`${WORK}/dist`);
  });
});
