import { describe, expect, it } from "vitest";
import { inspectRuntimeSource, replaceRuntimeSourceImage } from "./runtime-source-images";

describe("reviewable image source edits", () => {
  it("cannot accidentally turn an external image into a previous build stage", () => {
    expect(() =>
      replaceRuntimeSourceImage(
        "FROM node:22 AS base\nFROM alpine:3\n",
        "dockerfile",
        "from:2",
        "base",
      ),
    ).toThrow();
  });
  it("keeps numeric image names as YAML strings", () => {
    expect(
      replaceRuntimeSourceImage(
        "services: {api: {image: node:22}}",
        "compose",
        "service:api",
        "123",
      ),
    ).toBe('services: {api: {image: "123"}}');
  });
  it.each([
    "GHCR.IO/team/app:v1",
    "registry.example.com:5000/team/my__app:v2",
    "[2001:db8::1]:5000/team/api:v2",
  ])("uses deployment reference rules and preserves YAML string meaning: %s", (image) => {
    expect(replaceRuntimeSourceImage("FROM node:22\n", "dockerfile", "from:1", image)).toBe(
      `FROM ${image}\n`,
    );
    const after = replaceRuntimeSourceImage(
      "services: {api: {image: node:22}}",
      "compose",
      "service:api",
      image,
    );
    expect(inspectRuntimeSource(after, "compose").references[0]?.image).toBe(image);
  });
  it("changes only the selected FROM, retaining stages, platform, comments and CRLF", () => {
    const source =
      "# syntax=docker/dockerfile:1\r\nFROM --platform=$BUILDPLATFORM node:22 AS build\r\nRUN echo ok\r\nFROM node:22-alpine AS runtime\r\nCOPY --from=build /app /app\r\nFROM runtime AS final\r\n";
    const result = inspectRuntimeSource(source, "dockerfile");
    expect(result.references.map((ref) => ref.image)).toEqual(["node:22", "node:22-alpine"]);
    expect(replaceRuntimeSourceImage(source, "dockerfile", "from:4", "node:22.23.4-alpine")).toBe(
      source.replace("node:22-alpine", "node:22.23.4-alpine"),
    );
  });
  it.each([
    "RUN <<EOF\nFROM node:22\nEOF\nFROM node:22\n",
    "# escape=`\nFROM node:22\n",
    "# syntax=example/custom:1\nFROM node:22\n",
    "FROM \\\nnode:22\n",
  ])("leaves ambiguous Dockerfiles to the source editor", (source) => {
    expect(inspectRuntimeSource(source, "dockerfile").references).toEqual([]);
    expect(() => replaceRuntimeSourceImage(source, "dockerfile", "from:1", "node:24")).toThrow();
  });
  it("does not treat stage aliases or dynamic ARG values as external literal images", () => {
    const result = inspectRuntimeSource(
      "ARG NODE=22\nFROM node:${NODE} AS base\nFROM base AS final\n",
      "dockerfile",
    );
    expect(result.references).toEqual([]);
    expect(result.guidance).toHaveLength(1);
  });
  it("preserves YAML formatting, comments and unrelated services while explicitly updating a digest", () => {
    const old = `node:22@sha256:${"a".repeat(64)}`;
    const source = `# stack\r\nservices:\r\n  api:\r\n    image: '${old}' # keep me\r\n    environment: {TZ: UTC}\r\n  db: {image: postgres:16}\r\n`;
    expect(inspectRuntimeSource(source, "compose", "api").references).toHaveLength(1);
    expect(
      replaceRuntimeSourceImage(source, "compose", "service:api", "node:22.23.4-alpine", "api"),
    ).toBe(source.replace(old, "node:22.23.4-alpine"));
    expect(() =>
      replaceRuntimeSourceImage(source, "compose", "service:db", "postgres:17", "api"),
    ).toThrow();
  });
  it("does not rewrite shared anchors, aliases, inherited images or build output tags", () => {
    const source =
      "x-base: &base {image: node:22}\nservices:\n  api:\n    <<: *base\n  worker:\n    image: &image node:22\n  other:\n    image: *image\n  built:\n    build: .\n    image: my/output:1\n  dynamic:\n    image: ${IMAGE:-node:22}\n";
    expect(inspectRuntimeSource(source, "compose").references).toEqual([]);
  });
  it.each([
    "services:\n  api: &base {image: node:22}\n  worker: *base\n",
    "services: &services {api: {image: node:22}}\nx-shared: *services\n",
    "x-build: &build {build: .}\nservices:\n  api: {<<: *build, image: my/output:1}\n",
    "services:\n  api: {extends: {file: base.yml, service: api}, image: my/output:1}\n",
  ])("does not edit shared service mappings or inherited build outputs", (source) => {
    expect(inspectRuntimeSource(source, "compose").references).toEqual([]);
    expect(() => replaceRuntimeSourceImage(source, "compose", "service:api", "node:24")).toThrow();
  });
  it("rejects duplicate YAML keys instead of updating an ambiguous field", () => {
    expect(() =>
      inspectRuntimeSource("services:\n  api:\n    image: node:22\n    image: node:24", "compose"),
    ).toThrow();
  });
  it.each([
    "node:24\nRUN evil",
    "${IMAGE}",
    "node:24 # test",
    "scratch",
    "node:24;true",
    "node@sha256:bad",
    "registry.example.com:0/team/api:v1",
    "registry.example.com:not-a-port/team/api:v1",
  ])("rejects expression/syntax injection: %s", (image) => {
    expect(() =>
      replaceRuntimeSourceImage("FROM node:22\n", "dockerfile", "from:1", image),
    ).toThrow();
  });
});
