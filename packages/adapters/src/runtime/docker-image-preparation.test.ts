import { describe, expect, it, vi } from "vitest";
import { AppError } from "@repo/core";
import { matchingRegistryDigest, prepareDockerImage } from "./docker-image-preparation";

const imageId = `sha256:${"a".repeat(64)}`;
const nextImageId = `sha256:${"b".repeat(64)}`;
const ref = "ghcr.io/acme/api:latest";
const digest = `ghcr.io/acme/api@sha256:${"c".repeat(64)}`;
const nextDigest = `ghcr.io/acme/api@sha256:${"d".repeat(64)}`;
const missing = () => Object.assign(new Error("No such image"), { statusCode: 404 });

function fixture(digests: string[] = [digest]) {
  let current = { Id: imageId, RepoDigests: digests };
  const inspect = vi.fn(async () => current);
  const pull = vi.fn(async () => {
    current = { Id: nextImageId, RepoDigests: [nextDigest] };
  });
  return { inspect, pull };
}

describe("deployment image preparation", () => {
  it("refreshes a cached registry tag and freezes the content acquired", async () => {
    const io = fixture();
    await expect(prepareDockerImage(ref, { refreshMutableTag: true }, io)).resolves.toEqual({
      imageId: nextImageId,
      deploymentRef: nextDigest,
      registryDigest: nextDigest,
    });
    expect(io.pull).toHaveBeenCalledExactlyOnceWith(ref, { force: true });
  });
  it("preserves cached local images even when manual deploys refresh tags", async () => {
    const io = fixture([]);
    await expect(
      prepareDockerImage("local-api:dev", { refreshMutableTag: true }, io),
    ).resolves.toEqual({
      imageId,
      deploymentRef: imageId,
    });
    expect(io.pull).not.toHaveBeenCalled();
  });
  it("does not mistake a local alias of a pulled base image for a registry image", async () => {
    const io = fixture([`ubuntu@sha256:${"c".repeat(64)}`]);
    const result = await prepareDockerImage("my-app:local", { refreshMutableTag: true }, io);
    expect(result.deploymentRef).toBe(imageId);
    expect(io.pull).not.toHaveBeenCalled();
  });
  it.each([digest, imageId])("reuses immutable reference %s", async (immutable) => {
    const io = fixture();
    await prepareDockerImage(immutable, { refreshMutableTag: true, force: true }, io);
    expect(io.pull).not.toHaveBeenCalled();
  });
  it("pulls a missing image before resolving its immutable identity", async () => {
    const io = fixture();
    io.inspect.mockRejectedValueOnce(missing());
    const result = await prepareDockerImage(ref, {}, io);
    expect(result.imageId).toBe(nextImageId);
    expect(io.pull).toHaveBeenCalledExactlyOnceWith(ref, { force: false });
  });
  it("does not replace a missing retained artifact with an upstream tag", async () => {
    const io = fixture();
    io.inspect.mockRejectedValueOnce(missing());
    await expect(
      prepareDockerImage(ref, { requirePresent: true, force: true }, io),
    ).rejects.toThrow("Retained image");
    expect(io.pull).not.toHaveBeenCalled();
  });
  it("does not try to pull a missing Docker image ID from a registry", async () => {
    const io = fixture();
    io.inspect.mockRejectedValueOnce(missing());
    await expect(prepareDockerImage(imageId, { force: true }, io)).rejects.toThrow("Retained image");
    expect(io.pull).not.toHaveBeenCalled();
  });
  it("retains an existing pin despite an explicit pull hint", async () => {
    const io = fixture();
    expect((await prepareDockerImage(ref, { requirePresent: true, force: true }, io)).imageId).toBe(
      imageId,
    );
    expect(io.pull).not.toHaveBeenCalled();
  });
  it("propagates an inspection failure without treating the daemon as empty", async () => {
    const io = fixture();
    io.inspect.mockRejectedValueOnce(
      Object.assign(new Error("daemon unavailable"), { statusCode: 500 }),
    );
    await expect(prepareDockerImage(ref, { refreshMutableTag: true }, io)).rejects.toThrow(
      "daemon unavailable",
    );
    expect(io.pull).not.toHaveBeenCalled();
  });
  it("preserves an ownership denial even when it has a 404 status", async () => {
    const io = fixture();
    io.inspect.mockRejectedValueOnce(
      new AppError("Image belongs to another project", 404, "IMAGE_NOT_FOUND"),
    );
    await expect(prepareDockerImage(ref, {}, io)).rejects.toThrow("another project");
    expect(io.pull).not.toHaveBeenCalled();
  });
  it("propagates registry failure instead of falling back to the cached image", async () => {
    const io = fixture();
    io.pull.mockRejectedValueOnce(new Error("registry denied the pull"));
    await expect(prepareDockerImage(ref, { refreshMutableTag: true }, io)).rejects.toThrow(
      "registry denied",
    );
  });
  it("rejects incomplete inspection metadata instead of activating a mutable ref", async () => {
    const io = fixture();
    io.inspect.mockResolvedValueOnce({ Id: "", RepoDigests: [] });
    await expect(prepareDockerImage(ref, {}, io)).rejects.toThrow("immutable Docker image ID");
  });
  it("does not resolve a pull that completed after cancellation", async () => {
    const controller = new AbortController();
    const io = fixture();
    io.pull.mockImplementationOnce(async () => {
      controller.abort();
    });
    await expect(
      prepareDockerImage(ref, { refreshMutableTag: true, signal: controller.signal }, io),
    ).rejects.toThrow("cancelled");
    expect(io.inspect).toHaveBeenCalledTimes(1);
  });
  it("does no image work when already cancelled", async () => {
    const io = fixture();
    await expect(prepareDockerImage(ref, { signal: AbortSignal.abort() }, io)).rejects.toThrow(
      "cancelled",
    );
    expect(io.inspect).not.toHaveBeenCalled();
    expect(io.pull).not.toHaveBeenCalled();
  });
});

describe("registry provenance", () => {
  it.each([
    "postgres:16",
    "library/postgres:16",
    "docker.io/postgres:16",
    "index.docker.io/library/postgres:16",
  ])("matches Docker Hub's canonical repository for %s", (ref) => {
    const canonical = `docker.io/library/postgres@sha256:${"c".repeat(64)}`;
    expect(matchingRegistryDigest(ref, [canonical])).toBe(canonical);
  });
  it("keeps registry ports and repository namespaces distinct", () => {
    const canonical = `localhost:5000/team/api@sha256:${"c".repeat(64)}`;
    expect(matchingRegistryDigest("localhost:5000/team/api:latest", [canonical])).toBe(canonical);
    expect(matchingRegistryDigest("localhost:5001/team/api:latest", [canonical])).toBeUndefined();
  });
});
