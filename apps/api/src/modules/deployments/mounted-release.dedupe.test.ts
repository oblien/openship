import { beforeEach, describe, expect, it, vi } from "vitest";

const { findInProgressByCommit, findById } = vi.hoisted(() => ({
  findInProgressByCommit: vi.fn(),
  findById: vi.fn(),
}));

vi.mock("@repo/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@repo/db")>();
  return {
    ...actual,
    repos: {
      deployment: { findInProgressByCommit, findById },
    },
  };
});

import { existingWebhookRelease } from "./mounted-release.service";

const SHA = "1eeaf7692a19ee6e7ecb64b9d1a5c3ee7c0ac2f5";

describe("existingWebhookRelease", () => {
  beforeEach(() => {
    findInProgressByCommit.mockReset();
    findById.mockReset();
  });

  it("returns an in-progress row at the same SHA", async () => {
    findInProgressByCommit.mockResolvedValue({ id: "dep-in", commitSha: SHA, status: "building" });

    const found = await existingWebhookRelease(
      { id: "proj-1", activeReleaseDeploymentId: "dep-live" },
      SHA,
    );

    expect(found?.id).toBe("dep-in");
    expect(findById).not.toHaveBeenCalled();
  });

  it("returns the active code release when it is already at that SHA", async () => {
    findInProgressByCommit.mockResolvedValue(undefined);
    findById.mockResolvedValue({ id: "dep-live", commitSha: SHA, status: "ready" });

    const found = await existingWebhookRelease(
      { id: "proj-1", activeReleaseDeploymentId: "dep-live" },
      SHA,
    );

    expect(found?.id).toBe("dep-live");
    expect(findById).toHaveBeenCalledWith("dep-live");
  });

  it("does not treat the runtime activeDeploymentId as a code-release match", async () => {
    findInProgressByCommit.mockResolvedValue(undefined);

    const found = await existingWebhookRelease(
      { id: "proj-1", activeReleaseDeploymentId: null },
      SHA,
    );

    expect(found).toBeUndefined();
    expect(findById).not.toHaveBeenCalled();
  });
});
