import { describe, expect, it, vi } from "vitest";
import {
  readSoftwareCache,
  softwareImageCandidates,
  SOFTWARE_CACHE_ROOT,
} from "./docker-software-cache";
const digest = `sha256:${"a".repeat(64)}`;
const sourceDigest = `sha256:${"b".repeat(64)}`;
const image = { path: "images/oven-bun-1-3-14", digest, sourceDigest, image: "oven/bun:1.3.14" };
const data = {
  pack: { version: 2, platform: "linux/amd64", images: [image] },
  platform: "linux/amd64",
  dockerfile: "FROM oven/bun:1.3.14\nCOPY . /app\n",
};
describe("immutable public software images", () => {
  it("uses a pinned local image only while its upstream tag still matches", async () => {
    const exec = vi.fn(async (command: string) =>
      command.startsWith("python3") ? JSON.stringify(data) : sourceDigest,
    );
    expect((await readSoftwareCache({ exec } as never, "/tmp/Dockerfile")).args).toBe(
      ` --build-context 'oven/bun:1.3.14=oci-layout://${SOFTWARE_CACHE_ROOT}/${image.path}@${digest}'`,
    );
    exec.mockImplementation(async (command) =>
      command.startsWith("python3") ? JSON.stringify(data) : `sha256:${"c".repeat(64)}`,
    );
    expect((await readSoftwareCache({ exec } as never, "/tmp/Dockerfile")).args).toBe("");
  });
  it("preserves Dockerfile platform, frontend, ARG and digest-pinned source semantics", () => {
    for (const dockerfile of [
      "FROM --platform=linux/arm64 oven/bun:1.3.14",
      "# syntax=docker/dockerfile:1\nFROM oven/bun:1.3.14",
      "ARG BASE\nFROM ${BASE}",
      `FROM oven/bun@${sourceDigest}`,
    ])
      expect(softwareImageCandidates(JSON.stringify({ ...data, dockerfile }))).toEqual([]);
    expect(
      softwareImageCandidates(
        JSON.stringify({ ...data, dockerfile: "FROM docker.io/oven/bun:1.3.14 AS build" }),
      )[0]?.reference,
    ).toBe("docker.io/oven/bun:1.3.14");
    expect(
      softwareImageCandidates(JSON.stringify({ ...data, dockerfile: "FROM alpine:3.22" })),
    ).toEqual([]);
    expect(() =>
      softwareImageCandidates(JSON.stringify({ ...data, platform: "linux/arm64" })),
    ).toThrow();
  });
  it("substitutes a pinned tracking reference only when its selected digest matches the pack", async () => {
    const pinned = { ...data, dockerfile: `FROM oven/bun:1.3.14@${sourceDigest}\n` };
    const exec = vi.fn(async (command: string) => command.startsWith("python3") ? JSON.stringify(pinned) : sourceDigest);
    expect((await readSoftwareCache({ exec } as never, "/tmp/Dockerfile")).args).toContain(`oven/bun:1.3.14@${sourceDigest}=oci-layout://`);
    expect(softwareImageCandidates(JSON.stringify({ ...pinned, dockerfile: `FROM oven/bun:1.3.14@${digest}\n` }))).toEqual([]);
  });
  it("rejects traversal, shell text and unpinned image data", () => {
    for (const path of [
      "../../root",
      "images/a,b",
      "images/$(id)",
      "images/a\nb",
      "/var/lib/docker",
      "images/a/../b",
    ])
      expect(() =>
        softwareImageCandidates(
          JSON.stringify({ ...data, pack: { ...data.pack, images: [{ ...image, path }] } }),
        ),
      ).toThrow();
    expect(() =>
      softwareImageCandidates(
        JSON.stringify({
          ...data,
          pack: { ...data.pack, images: [{ ...image, sourceDigest: "latest" }] },
        }),
      ),
    ).toThrow();
  });
  it("falls back on absent, malformed or unreadable packs and unavailable registry metadata", async () => {
    for (const value of [
      "",
      "broken",
      JSON.stringify({ ...data, pack: { ...data.pack, version: 1 } }),
    ])
      expect(
        (await readSoftwareCache({ exec: async () => value } as never, "/tmp/Dockerfile")).args,
      ).toBe("");
    const exec = async (command: string) => {
      if (command.startsWith("python3")) return JSON.stringify(data);
      throw new Error("network unavailable");
    };
    expect(await readSoftwareCache({ exec } as never, "/tmp/Dockerfile")).toEqual({
      args: "",
      unavailable: true,
    });
  });
  it("reports a missing software mount instead of silently implying shared images were used", async () => {
    expect(await readSoftwareCache({ exec: async () => "" } as never, "/tmp/Dockerfile")).toEqual({
      args: "", unavailable: true,
    });
  });
  it("never swallows deployment cancellation", async () => {
    const abort = new AbortController();
    const reason = new Error("cancelled");
    const exec = async () => {
      abort.abort(reason);
      return JSON.stringify(data);
    };
    await expect(
      readSoftwareCache({ exec } as never, "/tmp/Dockerfile", abort.signal),
    ).rejects.toBe(reason);
  });
});
