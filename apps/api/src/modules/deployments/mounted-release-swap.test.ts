import { describe, expect, it } from "vitest";
import {
  retainedReleaseNeedsRepository,
  retainedReleaseTreeExists,
} from "./mounted-release.service";

const tree = "/var/lib/openship/mounted-releases/proj_1/releases/dep_old";

describe("retained code-release rollback", () => {
  it("is a pointer flip when the release tree is still on disk", () => {
    expect(
      retainedReleaseNeedsRepository({
        id: "dep_old",
        imageRef: null,
        meta: { deploymentLane: "release", mountedReleaseRoot: tree },
      }),
    ).toBe(false);
  });

  it("needs a fetch when the tree path is missing or is the project root", () => {
    expect(
      retainedReleaseNeedsRepository({
        id: "dep_old",
        imageRef: null,
        meta: { deploymentLane: "release" },
      }),
    ).toBe(true);
    expect(
      retainedReleaseNeedsRepository({
        id: "dep_old",
        imageRef: null,
        meta: {
          deploymentLane: "release",
          mountedReleaseRoot: "/var/lib/openship/mounted-releases/proj_1",
        },
      }),
    ).toBe(true);
  });

  it("probes the host for the retained tree before fetching", async () => {
    const exec = async (cmd: string) => (cmd.includes(tree) ? "yes\n" : "no\n");
    await expect(
      retainedReleaseTreeExists(
        { exec },
        {
          id: "dep_old",
          imageRef: null,
          meta: { mountedReleaseRoot: tree },
        },
      ),
    ).resolves.toBe(tree);
    await expect(
      retainedReleaseTreeExists(
        { exec: async () => "no\n" },
        {
          id: "dep_old",
          imageRef: null,
          meta: { mountedReleaseRoot: tree },
        },
      ),
    ).resolves.toBeNull();
  });
});
