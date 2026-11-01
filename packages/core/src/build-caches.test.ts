import { describe, expect, it } from "vitest";
import { manualBuildCaches } from "./build-caches";

describe("manual build cache classification", () => {
  it.each([
    ["nextjs", "bun", "/root/.bun/install/cache"],
    ["django", "pip", "/root/.cache/pip"],
    ["laravel", "composer", "/root/.cache/composer"],
    ["rails", "bundler", "/usr/local/bundle/cache"],
    ["go", "go", "/go/pkg/mod"],
    ["rust", "cargo", "/usr/local/cargo/registry"],
    ["springboot", "maven", "/root/.m2/repository"],
  ])(
    "recognizes %s package caches without including application data",
    (framework, packageManager, target) => {
      expect(
        manualBuildCaches({
          framework,
          packageManager,
          volumes: [
            `cache:${target}`,
            "data:/app/data",
            "deps:/app/node_modules",
            "db:/var/lib/postgresql/data",
          ],
        }),
      ).toEqual([{ spec: `cache:${target}`, target }]);
    },
  );
  it("maps app-relative Next cache mounts to the selected workspace app and preserves original specs", () => {
    expect(
      manualBuildCaches({
        framework: "nextjs",
        packageManager: "bun",
        rootDirectory: "apps/web",
        volumes: [
          ".next/cache",
          "next:/app/.next/cache:rw",
          "output:/app/.next",
          "other:/workspace/apps/other/.next/cache",
        ],
      }),
    ).toEqual([
      { spec: ".next/cache", target: "/workspace/apps/web/.next/cache" },
      { spec: "next:/app/.next/cache:rw", target: "/workspace/apps/web/.next/cache" },
    ]);
  });
});
