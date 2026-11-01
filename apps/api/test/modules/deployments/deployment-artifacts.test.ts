import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Deployment } from "@repo/db";
import type { RuntimeAdapter } from "@repo/adapters";

const h = vi.hoisted(() => ({ save: vi.fn(), prepare: vi.fn() }));
vi.mock("@repo/db", () => ({ repos: { deployment: { recordCompletedBuildArtifacts: h.save } } }));
vi.mock("@repo/adapters", () => ({
  DockerRuntime: class {
    prepareDeploymentImage = h.prepare;
  },
}));
import { DockerRuntime } from "@repo/adapters";
import {
  deploymentArtifacts,
  hasRetryableBuild,
  recordDeploymentArtifacts,
} from "@repo/platform/engine/modules/deployments/deployment-artifacts";

const imageId = `sha256:${"a".repeat(64)}`;
const runtime = () => new (DockerRuntime as unknown as new () => RuntimeAdapter)();
const dep = () =>
  ({
    id: "attempt",
    projectId: "p",
    organizationId: "org",
    status: "deploying",
    meta: { port: 3000 },
  }) as Deployment;
beforeEach(() => {
  vi.clearAllMocks();
  h.save.mockResolvedValue(true);
  h.prepare.mockResolvedValue({ imageId });
});

describe("completed build receipts", () => {
  it("freezes a completed image by ID without pulling and records it for that owner", async () => {
    const attempt = dep();
    const receipt = await recordDeploymentArtifacts(attempt, runtime(), [
      { imageRef: "openship/app:bld_done" },
    ]);
    expect(h.prepare).toHaveBeenCalledExactlyOnceWith("openship/app:bld_done", {
      requirePresent: true,
    });
    expect(h.save).toHaveBeenCalledExactlyOnceWith("attempt", "org", {
      version: 1,
      images: [{ imageRef: "openship/app:bld_done", imageId }],
    });
    expect(deploymentArtifacts(attempt.meta)).toEqual(receipt);
    expect(hasRetryableBuild({ ...attempt, status: "failed" })).toBe(true);
    expect(hasRetryableBuild({ ...attempt, status: "cancelled" })).toBe(false);
    expect(hasRetryableBuild({ ...attempt, status: "partial_failure" })).toBe(false);
  });

  it("never records a partial cohort, vanished image or refused cancellation write", async () => {
    const attempt = dep();
    h.prepare.mockResolvedValueOnce({ imageId }).mockRejectedValueOnce(new Error("Image gone"));
    await expect(
      recordDeploymentArtifacts(attempt, runtime(), [
        { imageRef: "a", serviceId: "a", serviceName: "web" },
        { imageRef: "b", serviceId: "b", serviceName: "api" },
      ]),
    ).rejects.toThrow("Image gone");
    expect(h.save).not.toHaveBeenCalled();
    expect(deploymentArtifacts(attempt.meta)).toBeUndefined();
    h.save.mockResolvedValue(false);
    h.prepare.mockResolvedValue({ imageId });
    expect(
      await recordDeploymentArtifacts(attempt, runtime(), [{ imageRef: "a" }]),
    ).toBeUndefined();
    expect(deploymentArtifacts(attempt.meta)).toBeUndefined();
  });

  it("does not advertise paths, bare execution or source-mounted services as image-only retries", async () => {
    expect(
      await recordDeploymentArtifacts(dep(), {} as RuntimeAdapter, [{ imageRef: "app" }]),
    ).toBeUndefined();
    expect(
      await recordDeploymentArtifacts(dep(), runtime(), [{ imageRef: "/release/static" }]),
    ).toBeUndefined();
    const attempt = dep();
    attempt.meta = { composeServices: [{ name: "app", volumes: ["./config:/config:ro"] }] };
    expect(
      await recordDeploymentArtifacts(attempt, runtime(), [{ imageRef: "app" }]),
    ).toBeUndefined();
    expect(h.save).not.toHaveBeenCalled();
  });

  it("refuses malformed or ambiguous saved receipts", () => {
    for (const images of [
      [],
      [{ imageRef: "tag", imageId: "latest" }],
      [{ imageRef: "tag", imageId, serviceId: "a" }],
      [
        { imageRef: "a", imageId, serviceId: "a", serviceName: "web" },
        { imageRef: "b", imageId, serviceId: "a", serviceName: "api" },
      ],
    ]) {
      expect(
        deploymentArtifacts({ completedBuildArtifacts: { version: 1, images } }),
      ).toBeUndefined();
    }
  });
});
