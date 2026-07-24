import { describe, expect, it } from "vitest";

import { parseVercelConfig } from "../src/metadata/vercel";
import { parseDeploymentMetadata } from "../src/metadata";
import { javascriptLanguageDetector } from "../src/languages/javascript";
import { phpLanguageDetector } from "../src/languages/php";

// `JSON.parse("null")` SUCCEEDS and yields null, so a `catch` around the parse
// doesn't cover the property access that follows. metadata/railway.ts already
// guards for exactly this ("would throw and crash the metadata pipeline"); the
// parsers below did not, so one degenerate file aborted detection for the whole
// project instead of being ignored.
//
// Note a bare primitive (`42`, `"str"`) never threw - JS boxes those on
// property access. `null` is the only JSON literal that does.

describe("JSON manifests containing a bare null", () => {
  it("parseVercelConfig returns null instead of throwing", () => {
    expect(parseVercelConfig("null")).toBeNull();
  });

  it("parseDeploymentMetadata survives a null vercel.json", () => {
    expect(() => parseDeploymentMetadata({ "vercel.json": "null" })).not.toThrow();
    expect(parseDeploymentMetadata({ "vercel.json": "null" })).toEqual([]);
  });

  it("the javascript detector returns no deps for a null package.json", () => {
    expect(javascriptLanguageDetector.parseManifest?.("package.json", "null")).toEqual({});
  });

  it("the php detector returns no deps for a null composer.json", () => {
    expect(phpLanguageDetector.parseManifest?.("composer.json", "null")).toEqual({});
  });

  it("still parses ordinary manifests", () => {
    expect(parseVercelConfig('{"framework":"nextjs"}')).toEqual({ framework: "nextjs" });
    expect(
      javascriptLanguageDetector.parseManifest?.(
        "package.json",
        '{"dependencies":{"next":"15.0.0"},"devDependencies":{"vitest":"4.0.0"}}',
      ),
    ).toEqual({ next: "15.0.0", vitest: "4.0.0" });
    expect(
      phpLanguageDetector.parseManifest?.(
        "composer.json",
        '{"require":{"laravel/framework":"^11"}}',
      ),
    ).toEqual({ "laravel/framework": "^11" });
  });

  it("still returns empty for malformed JSON", () => {
    expect(parseVercelConfig("{not json")).toBeNull();
    expect(javascriptLanguageDetector.parseManifest?.("package.json", "{not json")).toEqual({});
    expect(phpLanguageDetector.parseManifest?.("composer.json", "{not json")).toEqual({});
  });
});
