import { describe, expect, it } from "vitest";

import {
  DOCKER_HUB_REGISTRY,
  normalizeRegistryHost,
  registryConfigKeys,
  registryForImage,
} from "./image-ref";

/**
 * These three functions have to agree, and that is the whole reason they live together:
 * `normalizeRegistryHost` decides what a saved CREDENTIAL is keyed by,
 * `registryForImage` decides what a PULL looks up, and `registryConfigKeys` spans the
 * spellings Docker itself has used. Any drift between them shows up as a credential the
 * operator can see in the UI and the pull cannot find.
 */

describe("registryForImage", () => {
  it("does not mistake a tag's colon for a registry port", () => {
    // No `/` means there is no registry component at all — but the tag's colon made the
    // whole reference read as a host:port (#581).
    expect(registryForImage("postgres:16-alpine")).toBe(DOCKER_HUB_REGISTRY);
    expect(registryForImage("nginx")).toBe(DOCKER_HUB_REGISTRY);
  });

  it("reads a real registry host, including a port", () => {
    expect(registryForImage("ghcr.io/oblien/openship-api:0.6.5")).toBe("ghcr.io");
    expect(registryForImage("registry.example.com:5000/org/img")).toBe("registry.example.com:5000");
    expect(registryForImage("localhost:5000/img")).toBe("localhost:5000");
  });

  it("treats a bare namespace as Hub", () => {
    expect(registryForImage("myorg/myimage:1.2")).toBe(DOCKER_HUB_REGISTRY);
    expect(registryForImage("library/postgres")).toBe(DOCKER_HUB_REGISTRY);
  });

  it("lowercases the host and tolerates surrounding space", () => {
    expect(registryForImage("  GHCR.IO/Org/Img  ")).toBe("ghcr.io");
  });
});

describe("normalizeRegistryHost", () => {
  it("folds what an operator might type onto one key", () => {
    for (const typed of [
      "ghcr.io",
      "GHCR.IO",
      "https://ghcr.io",
      "https://ghcr.io/",
      "  ghcr.io/  ",
      "http://ghcr.io",
      "ghcr.io/oblien",
    ]) {
      expect(normalizeRegistryHost(typed), typed).toBe("ghcr.io");
    }
  });

  it("keeps a port, which is part of the host", () => {
    expect(normalizeRegistryHost("https://registry.example.com:5000/")).toBe(
      "registry.example.com:5000",
    );
  });

  it("folds every Hub spelling onto docker.io", () => {
    for (const hub of [
      "docker.io",
      "index.docker.io",
      "registry-1.docker.io",
      "https://index.docker.io/v1/",
      "https://index.docker.io/v1",
    ]) {
      expect(normalizeRegistryHost(hub), hub).toBe(DOCKER_HUB_REGISTRY);
    }
  });

  it("agrees with registryForImage for the same registry", () => {
    // The invariant that matters: a credential saved from a typed host matches the
    // registry a pull derives from an image reference.
    expect(normalizeRegistryHost("https://ghcr.io/")).toBe(registryForImage("ghcr.io/o/i:1"));
    expect(normalizeRegistryHost("index.docker.io")).toBe(registryForImage("postgres:16"));
  });
});

describe("registryConfigKeys", () => {
  it("spans the spellings Docker CLI writes for Hub", () => {
    const keys = registryConfigKeys("docker.io");
    expect(keys).toContain("https://index.docker.io/v1/");
    expect(keys).toContain("docker.io");
  });

  it("offers bare, https and trailing-slash forms for a private registry", () => {
    const keys = registryConfigKeys("registry.example.com");
    expect(keys[0]).toBe("registry.example.com");
    expect(keys).toContain("https://registry.example.com");
    expect(keys).toContain("registry.example.com/");
  });

  it("normalizes its input first, so a typed URL still yields the right keys", () => {
    expect(registryConfigKeys("https://ghcr.io/")).toEqual(registryConfigKeys("ghcr.io"));
  });
});
