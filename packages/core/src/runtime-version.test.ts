import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  RUNTIME_VERSION_PATTERN,
  RUNTIME_VERSION_MAX_LENGTH,
  getRuntimeVersionPolicy,
  supportsRuntimeImageOverride,
  supportsBuildImageOverride,
  runtimeNeedsInstall,
  assertRuntimeVersionTarget,
  runtimeProjectUpdate,
  resolveRuntimeImages,
} from "./runtime-version";
import { parseOpenshipConfig } from "./openship-config/parse";

describe("runtime version selection", () => {
  it("keeps the public schema generic and in sync with parser syntax", () => {
    const schema = JSON.parse(
      readFileSync(
        new URL("../../../apps/web/public/openship.schema.json", import.meta.url),
        "utf8",
      ),
    );
    expect(schema.properties).not.toHaveProperty("phpVersion");
    expect(schema.properties.runtimeVersion).toMatchObject({
      type: "string",
      pattern: RUNTIME_VERSION_PATTERN,
      maxLength: RUNTIME_VERSION_MAX_LENGTH,
    });
    expect(schema.properties.runtimeVersion).not.toHaveProperty("enum");
    for (const runtimeVersion of ["22", "8.3", "3.13.1"]) {
      expect(parseOpenshipConfig({ runtimeVersion }).errors).toEqual([]);
    }
    for (const runtimeVersion of [
      "",
      "8.3\nFROM evil",
      "8.3\n",
      8.3,
      "8.",
      "1.2.3.4",
      "1".repeat(33),
    ]) {
      expect(parseOpenshipConfig({ runtimeVersion }).errors).not.toEqual([]);
    }
  });
  it("validates a declared runtime immediately and waits for detection when omitted", () => {
    expect(parseOpenshipConfig({ framework: "laravel", runtimeVersion: "8.3" }).errors).toEqual([]);
    expect(parseOpenshipConfig({ framework: "laravel", runtimeVersion: "8.5" }).errors).toEqual([
      expect.stringMatching(/runtimeVersion: Unsupported.*For PHP/),
    ]);
    expect(parseOpenshipConfig({ framework: "node", runtimeVersion: "22" }).errors).toEqual([
      expect.stringMatching(/runtimeVersion: is not supported for node/),
    ]);
    expect(parseOpenshipConfig({ runtimeVersion: "22" }).errors).toEqual([]);
  });
  it("derives the catalog from the runtime language, including framework labels", () => {
    expect(getRuntimeVersionPolicy("laravel")).toBe(getRuntimeVersionPolicy("symfony"));
    expect(getRuntimeVersionPolicy("Laravel")).toMatchObject({
      label: "PHP",
      defaultVersion: "8.4",
      versions: ["8.3", "8.4"],
    });
    expect(getRuntimeVersionPolicy("node")).toBeUndefined();
    expect(getRuntimeVersionPolicy()).toBeUndefined();
  });
  it("requires Composer for selected PHP sources without changing legacy defaults", () => {
    expect(runtimeNeedsInstall("laravel", "8.3", "composer install")).toBe(true);
    expect(runtimeNeedsInstall("laravel", undefined, "composer install")).toBe(false);
    expect(runtimeNeedsInstall("laravel", "8.3", "")).toBe(false);
    expect(runtimeNeedsInstall("node", "8.3", "npm install")).toBe(false);
  });
  it.each(["8.3", "8.4"])("resolves a matching PHP %s pair", (runtimeVersion) => {
    expect(resolveRuntimeImages("laravel", runtimeVersion)).toEqual({
      runtimeVersion,
      buildImage: `php:${runtimeVersion}-cli-bookworm`,
      runtimeImage: `dunglas/frankenphp:1-php${runtimeVersion}-bookworm`,
    });
  });
  it.each(["8.1", "8.5", "8", "8.3.1"])(
    "validates %s against the runtime catalog, separately from public syntax",
    (runtimeVersion) => {
      expect(parseOpenshipConfig({ runtimeVersion }).errors).toEqual([]);
      expect(() => resolveRuntimeImages("laravel", runtimeVersion)).toThrow(
        /Unsupported runtimeVersion.*For PHP/,
      );
    },
  );
  it("does not treat a PHP version as a supported Node or Ruby selection", () => {
    for (const framework of ["node", "rails", undefined]) {
      expect(() => resolveRuntimeImages(framework, "8.3")).toThrow(
        /runtimeVersion is not supported/,
      );
      expect(() => assertRuntimeVersionTarget({ framework, runtimeVersion: "8.3" })).toThrow(
        /runtimeVersion is not supported/,
      );
    }
  });
  it("keeps a custom matching builder and rejects an incompatible one", () => {
    expect(resolveRuntimeImages("laravel", "8.3", "php:8.3.30-cli-bookworm").buildImage).toBe(
      "php:8.3.30-cli-bookworm",
    );
    expect(resolveRuntimeImages("laravel", "8.3", "example/php-builder:custom").buildImage).toBe(
      "example/php-builder:custom",
    );
    expect(() => resolveRuntimeImages("laravel", "8.3", "php:8.4-cli")).toThrow(/uses PHP 8.4/);
    expect(() => resolveRuntimeImages("laravel", "8.3", "php:8.3-cli\nRUN echo bad")).toThrow(
      /valid Docker image/,
    );
  });
  it("preserves omission and only replaces a previously managed default", () => {
    const legacy = { framework: "laravel", buildImage: "php:8.4-cli" };
    const selected = {
      framework: "laravel",
      runtimeVersion: "8.3",
      buildImage: "php:8.3-cli-bookworm",
    };
    expect(runtimeProjectUpdate(legacy, {})).toEqual({});
    expect(runtimeProjectUpdate(legacy, { runtimeVersion: "8.3" })).toEqual({
      runtimeVersion: "8.3",
      buildImage: "php:8.3-cli-bookworm",
    });
    expect(runtimeProjectUpdate(selected, { runtimeVersion: "8.4" })).toEqual({
      runtimeVersion: "8.4",
      buildImage: "php:8.4-cli-bookworm",
    });
    expect(() =>
      runtimeProjectUpdate(
        { ...selected, buildImage: "php:8.3.30-cli-bookworm" },
        { runtimeVersion: "8.4" },
      ),
    ).toThrow(/uses PHP 8.3/);
    expect(runtimeProjectUpdate(selected, { runtimeVersion: null })).toEqual({
      runtimeVersion: null,
      buildImage: "php:8.4-cli",
    });
    expect(
      runtimeProjectUpdate(
        { ...selected, buildImage: "example/php-builder:custom" },
        { runtimeVersion: null },
      ),
    ).toEqual({ runtimeVersion: null, buildImage: "example/php-builder:custom" });
  });
  it("requires clearing an explicit selection when changing to an unsupported runtime", () => {
    const previous = {
      framework: "laravel",
      runtimeVersion: "8.3",
      buildImage: "php:8.3-cli-bookworm",
    };
    expect(() => runtimeProjectUpdate(previous, { framework: "node" })).toThrow(
      /not supported for node/,
    );
    expect(
      runtimeProjectUpdate(previous, {
        framework: "node",
        runtimeVersion: null,
        buildImage: "node:22",
      }),
    ).toEqual({ runtimeVersion: null, buildImage: "node:22" });
    expect(
      runtimeProjectUpdate({ framework: "node", buildImage: "node:22" }, { runtimeVersion: null }),
    ).toEqual({ runtimeVersion: null });
    expect(runtimeProjectUpdate(null, { framework: "laravel", runtimeVersion: "8.3" })).toEqual({
      runtimeVersion: "8.3",
      buildImage: "php:8.3-cli-bookworm",
    });
  });
  it.each([
    { runtimeMode: "bare" },
    { projectType: "monorepo" },
    { composePath: "compose.yml" },
    { sourceKind: "image" },
    { buildKind: "dockerfile" },
    { workloadType: "static" },
  ])("refuses unsupported execution targets %j", (override) => {
    expect(supportsRuntimeImageOverride(override)).toBe(false);
    expect(() =>
      assertRuntimeVersionTarget({ runtimeVersion: "8.3", framework: "laravel", ...override }),
    ).toThrow(/generated PHP Docker/);
    expect(() => assertRuntimeVersionTarget(override)).not.toThrow();
  });
  it.each(["web", "worker"])("supports generated Docker %s runtime images", (workloadType) => {
    const target = { runtimeMode: "docker", projectType: "app", buildKind: "buildpack", workloadType };
    expect(supportsBuildImageOverride(target)).toBe(true);
    expect(supportsRuntimeImageOverride(target)).toBe(true);
    expect(() => assertRuntimeVersionTarget({ ...target, runtimeImage: "custom/runtime:1" })).not.toThrow();
  });
  it("offers a static builder without enabling a nonexistent application runtime", () => {
    const target = { runtimeMode: "docker", projectType: "app", buildKind: "static", workloadType: "static" };
    expect(supportsBuildImageOverride(target)).toBe(true);
    expect(supportsRuntimeImageOverride(target)).toBe(false);
    expect(() => assertRuntimeVersionTarget({ ...target, runtimeImage: "custom/runtime:1" })).toThrow(/generated.*Docker/);
  });
});

it("preserves custom images, validates version changes, and resets the override explicitly", () => {
  const previous = {
    framework: "laravel",
    runtimeVersion: "8.3",
    buildImage: "php:8.3-cli-bookworm",
    runtimeImage: "custom/frankenphp:83",
  };
  expect(runtimeProjectUpdate(previous, {})).not.toHaveProperty("runtimeImage");
  expect(runtimeProjectUpdate(previous, { runtimeVersion: "8.4" })).toMatchObject({
    runtimeVersion: "8.4",
  });
  expect(runtimeProjectUpdate(previous, { runtimeImage: null })).toMatchObject({
    runtimeImage: null,
  });
  expect(() =>
    runtimeProjectUpdate(previous, { runtimeImage: "dunglas/frankenphp:1-php8.4-bookworm" }),
  ).toThrow(/uses PHP 8.4/);
  expect(() => runtimeProjectUpdate(previous, { runtimeImage: "php:8.3-fpm" })).toThrow(
    /must provide FrankenPHP/,
  );
  expect(() =>
    runtimeProjectUpdate(previous, { runtimeImage: "custom/image:x\nFROM bad" }),
  ).toThrow(/valid Docker image/);
  expect(runtimeProjectUpdate(previous, { runtimeImage: " custom/image:83 " })).toMatchObject({
    runtimeImage: "custom/image:83",
  });
  expect(() =>
    runtimeProjectUpdate(
      { ...previous, runtimeVersion: null, buildImage: "php:8.4-cli" },
      { runtimeImage: "dunglas/frankenphp:1-php8.3-bookworm" },
    ),
  ).toThrow(/uses PHP 8.3/);
  expect(parseOpenshipConfig({ runtimeImage: "foo\nFROM bad" }).errors).toEqual([
    expect.stringMatching(/^runtimeImage:/),
  ]);
  expect(() =>
    assertRuntimeVersionTarget({ runtimeImage: "custom/image:latest", runtimeMode: "bare" }),
  ).toThrow(/generated.*Docker/);
});
