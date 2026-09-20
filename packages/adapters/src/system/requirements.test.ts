import { describe, expect, it } from "vitest";

import {
  REMOTE_SERVER_REQUIRED_COMPONENTS,
  resolveSystemComponentInstallPlan,
} from "./requirements";

describe("system component prerequisite policy", () => {
  it("requires Docker and Git on every managed remote server", () => {
    expect(REMOTE_SERVER_REQUIRED_COMPONENTS).toEqual(["docker", "git"]);
  });

  it("inserts Docker before an Edge-only request", () => {
    expect(resolveSystemComponentInstallPlan(["edge"])).toEqual(["docker", "edge"]);
  });

  it("normalizes reversed input and de-duplicates components", () => {
    expect(resolveSystemComponentInstallPlan(["edge", "git", "docker", "edge"])).toEqual([
      "docker",
      "edge",
      "git",
    ]);
  });
});
