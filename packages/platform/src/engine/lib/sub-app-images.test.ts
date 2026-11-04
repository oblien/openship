import { describe, expect, it } from "vitest";
import { getBuildImage, getRuntimeImage, type StackId } from "@repo/core";
import { resolveSubAppImages } from "./deployable-service";

const parent = {
  framework: "unknown",
  packageManager: "npm",
  buildImage: "ubuntu:22.04",
  runtimeImage: "ubuntu:22.04",
};

describe("sub-app runtime images", () => {
  it.each(["node", null])("keeps the chosen Node toolchain for framework %s", (framework) => {
    expect(
      resolveSubAppImages({ framework, buildImage: "node:22-bookworm-slim" }, parent),
    ).toMatchObject({ buildImage: "node:22-bookworm-slim", runtimeImage: "node:22-bookworm-slim" });
  });

  it.each(["node", "python", "go", "rails"] as StackId[])(
    "resolves missing images from the %s service instead of the generic parent",
    (framework) => {
      const images = resolveSubAppImages({ framework, buildImage: null }, parent);
      expect(images.buildImage).toBe(getBuildImage(framework, "npm"));
      expect(images.runtimeImage).toBe(getRuntimeImage(framework, "npm", images.buildImage));
      expect(images.runtimeImage).not.toBe(parent.runtimeImage);
    },
  );

  it("supplies a builder when neither the service nor snapshot persisted one", () => {
    expect(resolveSubAppImages({}, { framework: "node", packageManager: "npm" })).toMatchObject({
      buildImage: "node:22",
      runtimeImage: "node:22",
    });
  });

  it("preserves a selected Node digest and OS variant through both stages", () => {
    const image = `node:22-alpine@sha256:${"a".repeat(64)}`;
    expect(resolveSubAppImages({ framework: "node", buildImage: image }, parent)).toMatchObject({
      buildImage: image,
      runtimeImage: image,
    });
  });

  it("preserves a custom toolchain when the framework is undetected", () => {
    const image = `registry.example.com/team/toolchain@sha256:${"b".repeat(64)}`;
    expect(getRuntimeImage("unknown", undefined, image)).toBe(image);
    expect(resolveSubAppImages({ buildImage: image }, parent).runtimeImage).toBe(image);
  });

  it("keeps explicit project runtime selections for an unchanged materialized app", () => {
    const snapshot = {
      framework: "php",
      packageManager: "composer",
      buildImage: "php:8.3-cli-bookworm",
      runtimeImage: "dunglas/frankenphp:1-php8.3-bookworm",
      runtimeVersion: "8.3",
      runtimeImageOverride: true,
    };
    for (const service of [{}, { framework: "php", buildImage: snapshot.buildImage }]) {
      expect(resolveSubAppImages(service, snapshot)).toEqual({
        buildImage: snapshot.buildImage,
        runtimeImage: snapshot.runtimeImage,
        runtimeVersion: "8.3",
        runtimeImageOverride: true,
      });
    }
  });

  it("does not apply a parent's PHP runtime selection to a Node sub-app", () => {
    expect(
      resolveSubAppImages(
        { framework: "node", packageManager: "npm" },
        {
          framework: "php",
          packageManager: "composer",
          buildImage: "php:8.3-cli-bookworm",
          runtimeImage: "dunglas/frankenphp:1-php8.3-bookworm",
          runtimeVersion: "8.3",
          runtimeImageOverride: true,
        },
      ),
    ).toEqual({
      buildImage: "node:22",
      runtimeImage: "node:22",
      runtimeVersion: undefined,
      runtimeImageOverride: false,
    });
  });

  it("switches both stages when the sub-app selects Bun", () => {
    const images = resolveSubAppImages(
      { packageManager: "bun" },
      {
        framework: "node",
        packageManager: "npm",
        buildImage: "node:22",
        runtimeImage: "node:22",
      },
    );
    expect(images.buildImage).toBe(getBuildImage("node", "bun"));
    expect(images.runtimeImage).toBe(images.buildImage);
  });
});
