import { describe, expect, test } from "vitest";
import { resolveStaticOutputPath } from "./stack-output";

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
