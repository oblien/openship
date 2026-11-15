import { describe, expect, it } from "vitest";
import { cloudDockerProjectPaths, isCloudProjectMountSource } from "./docker-paths";

describe("managed Cloud mount ownership", () => {
  const root = cloudDockerProjectPaths("project-a").mounts;
  it("recognizes descendants of this project's immutable storage root", () => {
    expect(isCloudProjectMountSource("project-a", `${root}/imports/run/data`)).toBe(true);
    expect(isCloudProjectMountSource("project-a", `${root}/data/../imports/run/data`)).toBe(true);
  });
  it.each([
    root, `${root}-other/data`, `${root}/../other/data`,
    `${cloudDockerProjectPaths("project-b").mounts}/data`,
    "/media", "/var/run/docker.sock", "relative/path",
  ])("rejects unowned or unconfined source %s", source => {
    expect(isCloudProjectMountSource("project-a", source)).toBe(false);
  });
  it("requires an explicit project identity", () => {
    expect(isCloudProjectMountSource("", `${root}/data`)).toBe(false);
  });
});
