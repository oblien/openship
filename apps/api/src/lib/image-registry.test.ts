import { describe, it, expect } from "vitest";
import { parseImageRef } from "@repo/platform/engine/lib/image-registry";

describe("parseImageRef", () => {
  it("Docker Hub namespaced repo → registry-1.docker.io, tag preserved", () => {
    expect(parseImageRef("n8nio/n8n:latest")).toEqual({
      registry: "registry-1.docker.io",
      repo: "n8nio/n8n",
      ref: "latest",
    });
  });

  it("Docker Hub official (single-name) → library/ prefix, default tag", () => {
    expect(parseImageRef("mysql")).toEqual({
      registry: "registry-1.docker.io",
      repo: "library/mysql",
      ref: "latest",
    });
    expect(parseImageRef("mysql:8.0")).toEqual({
      registry: "registry-1.docker.io",
      repo: "library/mysql",
      ref: "8.0",
    });
  });

  it("explicit registry host (ghcr.io) is detected by the dot", () => {
    expect(parseImageRef("ghcr.io/get-convex/convex-backend:latest")).toEqual({
      registry: "ghcr.io",
      repo: "get-convex/convex-backend",
      ref: "latest",
    });
  });

  it("digest ref is split on @", () => {
    expect(parseImageRef("n8nio/n8n@sha256:abc")).toEqual({
      registry: "registry-1.docker.io",
      repo: "n8nio/n8n",
      ref: "sha256:abc",
    });
  });

  it("registry with a port is not mistaken for a tag", () => {
    expect(parseImageRef("localhost:5000/team/app:v1")).toEqual({
      registry: "localhost:5000",
      repo: "team/app",
      ref: "v1",
    });
  });

  it("empty → null", () => {
    expect(parseImageRef("")).toBeNull();
  });
});
