import { describe, expect, it } from "vitest";
import { collectDependencies } from "../src/languages";

describe("language-owned role dependencies", () => {
  const composer = JSON.stringify({
    require: { "laravel/framework": "^12", "production/worker": "^1" },
    "require-dev": { "laravel/horizon": "^5", "laravel/pint": "^1" },
  });

  it("keeps development dependencies available for framework detection", () => {
    expect(collectDependencies({ "composer.json": composer })).toEqual({
      "laravel/framework": "^12",
      "production/worker": "^1",
      "laravel/horizon": "^5",
      "laravel/pint": "^1",
    });
  });

  it.each(["composer.json", "Composer.JSON"])(
    "uses PHP's production install policy for role suggestions from %s",
    (filename) => {
      expect(collectDependencies({ [filename]: composer }, "roles")).toEqual({
        "laravel/framework": "^12",
        "production/worker": "^1",
      });
    },
  );

  it("retains production dependencies even when the same package appears in require-dev", () => {
    const files = { "composer.json": JSON.stringify({
      require: { "laravel/horizon": "^5" },
      "require-dev": { "laravel/horizon": "^6" },
    }) };
    expect(collectDependencies(files, "roles")).toEqual({ "laravel/horizon": "^5" });
  });

  it("preserves the other language parsers and manifests in the shared collector", () => {
    const files = {
      Gemfile: "gem 'rails'\ngem 'good_job'\n",
      "composer.json": composer,
    };
    expect(collectDependencies(files, "roles")).toEqual({
      rails: "*", good_job: "*", "laravel/framework": "^12", "production/worker": "^1",
    });
    expect(collectDependencies({ Gemfile: files.Gemfile }, "roles"))
      .toEqual(collectDependencies({ Gemfile: files.Gemfile }));
  });

  it.each([undefined, {}, { "composer.json": "null" }, { "composer.json": "{invalid" }])(
    "handles missing or invalid manifests without guessing dependencies (%j)",
    (files) => {
      expect(collectDependencies(files, "roles")).toEqual({});
    },
  );
});
