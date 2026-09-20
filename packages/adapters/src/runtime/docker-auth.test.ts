import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DockerCredentialHelperError,
  registryForImage,
  resolveDockerAuth,
} from "./docker-auth";

/**
 * #581: dockerode does not read `~/.docker/config.json`, so a local pull went out
 * anonymous on a `docker login`-ed host and private-image deploys failed.
 *
 * The hard part is not sending the credential — it is being exact about when NOT to
 * fail. A credential held in an external helper cannot be read from inside the
 * container, but a global `credsStore` is set on most developer machines (Docker
 * Desktop writes one by default) and says nothing about whether the image being
 * pulled needs credentials at all. So the helper failure has to be scoped to the
 * registry actually being pulled, or every anonymous pull of a public image breaks on
 * a machine where it worked.
 */

let dir: string;

async function writeConfig(config: unknown): Promise<void> {
  await mkdir(join(dir, ".docker"), { recursive: true });
  await writeFile(join(dir, ".docker", "config.json"), JSON.stringify(config), "utf8");
}

const basic = (user: string, pass: string) => Buffer.from(`${user}:${pass}`).toString("base64");

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "openship-docker-auth-"));
  process.env.DOCKER_CONFIG = join(dir, ".docker");
});

afterEach(async () => {
  delete process.env.DOCKER_CONFIG;
  await rm(dir, { recursive: true, force: true });
});

describe("registryForImage", () => {
  it("does not mistake a tag's colon for a registry port", () => {
    // The bug this exists to prevent: with no `/` there is no registry component at
    // all, but `postgres:16-alpine`.includes(":") is true, so the whole reference was
    // returned as the registry — matching no credential and printing as the registry
    // name in errors.
    expect(registryForImage("postgres:16-alpine")).toBe("docker.io");
    expect(registryForImage("redis:7-alpine")).toBe("docker.io");
    expect(registryForImage("nginx")).toBe("docker.io");
  });

  it("reads a real registry host", () => {
    expect(registryForImage("ghcr.io/oblien/openship-api:0.6.5")).toBe("ghcr.io");
    expect(registryForImage("registry.example.com/org/img:tag")).toBe("registry.example.com");
    expect(registryForImage("registry.example.com:5000/org/img")).toBe("registry.example.com:5000");
    expect(registryForImage("localhost:5000/img")).toBe("localhost:5000");
  });

  it("treats a bare namespace as Hub", () => {
    expect(registryForImage("myorg/myimage:1.2")).toBe("docker.io");
    expect(registryForImage("library/postgres")).toBe("docker.io");
  });
});

describe("resolveDockerAuth — inline credentials", () => {
  it("resolves basic auth for the matching registry", async () => {
    await writeConfig({ auths: { "registry.example.com": { auth: basic("bob", "s3cr3t") } } });
    await expect(resolveDockerAuth("registry.example.com/org/img:1")).resolves.toEqual({
      username: "bob",
      password: "s3cr3t",
      serveraddress: "registry.example.com",
    });
  });

  it("keeps a password containing a colon intact", async () => {
    // `auth` is base64("user:pass") and a password may itself contain colons — split on
    // the FIRST one only, or the credential is silently truncated.
    await writeConfig({ auths: { "r.example.com": { auth: basic("bob", "a:b:c") } } });
    await expect(resolveDockerAuth("r.example.com/img")).resolves.toMatchObject({
      username: "bob",
      password: "a:b:c",
    });
  });

  it("resolves an identity token", async () => {
    await writeConfig({ auths: { "r.example.com": { identitytoken: "tok_123" } } });
    await expect(resolveDockerAuth("r.example.com/img")).resolves.toMatchObject({
      identitytoken: "tok_123",
    });
  });

  it("finds Hub under the v1 URL the CLI actually writes", async () => {
    // `docker login` records this key while the image reference says `docker.io`, so a
    // literal lookup of the registry name finds nothing.
    await writeConfig({
      auths: { "https://index.docker.io/v1/": { auth: basic("me", "pat") } },
    });
    await expect(resolveDockerAuth("myorg/private:1")).resolves.toMatchObject({
      username: "me",
    });
  });

  it("finds a registry stored under its https:// URL form", async () => {
    // Configs written by hand or by CI use the URL form; exact-match-only lookup
    // silently reported "no credential" for the very registry the operator logged into.
    await writeConfig({ auths: { "https://registry.example.com": { auth: basic("u", "p") } } });
    await expect(resolveDockerAuth("registry.example.com/img")).resolves.toMatchObject({
      username: "u",
    });
  });

  it("prefers explicit username/password over the encoded blob", async () => {
    await writeConfig({
      auths: { "r.example.com": { username: "u", password: "p", auth: basic("x", "y") } },
    });
    await expect(resolveDockerAuth("r.example.com/img")).resolves.toMatchObject({ username: "u" });
  });
});

describe("resolveDockerAuth — pulls that must stay anonymous", () => {
  it("returns nothing when no config exists", async () => {
    await expect(resolveDockerAuth("postgres:16-alpine")).resolves.toBeUndefined();
  });

  it("returns nothing for a registry that has no entry", async () => {
    await writeConfig({ auths: { "other.example.com": { auth: basic("u", "p") } } });
    await expect(resolveDockerAuth("registry.example.com/img")).resolves.toBeUndefined();
  });

  it("does not fail a PUBLIC pull just because a global credsStore is set", async () => {
    // THE regression this guards. Docker Desktop writes `credsStore` by default, so
    // treating its presence as fatal broke every anonymous pull on a normal machine.
    await writeConfig({ credsStore: "desktop" });
    await expect(resolveDockerAuth("postgres:16-alpine")).resolves.toBeUndefined();
  });

  it("stays anonymous when credsStore is set and only OTHER registries are logged in", async () => {
    await writeConfig({
      credsStore: "desktop",
      auths: { "https://index.docker.io/v1/": {} },
    });
    await expect(resolveDockerAuth("registry.example.com/img")).resolves.toBeUndefined();
  });

  it("returns nothing for a malformed config rather than failing the pull", async () => {
    await mkdir(join(dir, ".docker"), { recursive: true });
    await writeFile(join(dir, ".docker", "config.json"), "{not json", "utf8");
    await expect(resolveDockerAuth("postgres:16-alpine")).resolves.toBeUndefined();
  });

  it("returns nothing for an entry with no usable material", async () => {
    await writeConfig({ auths: { "r.example.com": {} } });
    await expect(resolveDockerAuth("r.example.com/img")).resolves.toBeUndefined();
  });

  it("returns nothing for an auth blob that is not user:pass", async () => {
    await writeConfig({ auths: { "r.example.com": { auth: Buffer.from("nope").toString("base64") } } });
    await expect(resolveDockerAuth("r.example.com/img")).resolves.toBeUndefined();
  });
});

describe("resolveDockerAuth — helper-backed credentials fail closed", () => {
  it("refuses when credHelpers names a helper for THIS registry", async () => {
    await writeConfig({ credHelpers: { "registry.example.com": "ecr-login" } });
    await expect(resolveDockerAuth("registry.example.com/img")).rejects.toBeInstanceOf(
      DockerCredentialHelperError,
    );
  });

  it("refuses when credsStore holds THIS registry's login", async () => {
    // `docker login` under a store records the registry in `auths` with the secret
    // moved out — entry present, nothing usable in it.
    await writeConfig({ credsStore: "desktop", auths: { "registry.example.com": {} } });
    await expect(resolveDockerAuth("registry.example.com/img")).rejects.toBeInstanceOf(
      DockerCredentialHelperError,
    );
  });

  it("does not name the helper or the config path in the message", async () => {
    await writeConfig({ credHelpers: { "registry.example.com": "osxkeychain" } });
    const err = await resolveDockerAuth("registry.example.com/img").catch((e: Error) => e);
    const message = (err as Error).message;
    expect(message).toContain("registry.example.com");
    expect(message).not.toContain("osxkeychain");
    expect(message).not.toContain(dir);
  });

  it("prefers usable inline material over refusing", async () => {
    // A store is configured globally but this registry has a real inline credential —
    // use it rather than failing.
    await writeConfig({
      credsStore: "desktop",
      auths: { "registry.example.com": { auth: basic("u", "p") } },
    });
    await expect(resolveDockerAuth("registry.example.com/img")).resolves.toMatchObject({
      username: "u",
    });
  });
});
