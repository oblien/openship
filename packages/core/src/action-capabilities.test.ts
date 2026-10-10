import { describe, expect, it } from "vitest";
import {
  actionContainerPlatform,
  actionRunnerArchitectures,
  actionRunnerLabels,
  actionRunnerMismatch,
} from "./action-capabilities";
import type { ActionCapabilities, ActionRunnerConfig } from "./actions";

const host: ActionCapabilities = {
  os: "linux",
  architecture: "x64",
  docker: true,
  git: true,
  node: true,
  distribution: "debian",
  version: "12",
};
const runner: ActionRunnerConfig = {
  mode: "container",
  image: "node:22",
  labels: [],
  cpu: 1,
  memoryMb: 2048,
  maxParallel: 1,
  allowDockerSocket: false,
};
const arm = { labels: ["self-hosted", "linux", "arm64"], requiresDocker: false };

describe("Actions execution architectures", () => {
  it("does not advertise emulation merely because Docker exists or a label claims it", () => {
    expect(actionRunnerMismatch(host, runner, arm)).toContain("arm64");
    expect(actionRunnerMismatch(host, { ...runner, labels: ["arm64"] }, arm)).toContain(
      "capabilities",
    );
    expect(actionRunnerArchitectures(host, runner)).toEqual(["x64"]);
  });
  it("dispatches verified emulated jobs and chooses the matching Docker platform", () => {
    const capabilities = { ...host, dockerPlatforms: ["linux/amd64", "linux/arm64"] as const };
    const verified = { ...capabilities, dockerPlatforms: [...capabilities.dockerPlatforms] };
    expect(actionRunnerMismatch(verified, runner, arm)).toBeNull();
    expect(actionRunnerLabels(verified, runner)).toEqual(["self-hosted", "linux", "x64", "arm64"]);
    expect(actionContainerPlatform(verified, runner, arm)).toBe("linux/arm64");
    expect(actionContainerPlatform(verified, runner, { labels: ["linux"] })).toBe("linux/amd64");
  });
  it("uses the Docker daemon CPU rather than the client host CPU", () => {
    const capabilities = {
      ...host,
      os: "macos" as const,
      architecture: "arm64" as const,
      dockerArchitecture: "x64" as const,
    };
    expect(actionRunnerArchitectures(capabilities, runner)).toEqual(["x64"]);
    expect(actionContainerPlatform(capabilities, runner, { labels: [] })).toBe("linux/amd64");
    expect(actionRunnerArchitectures(capabilities, { mode: "native" })).toEqual(["arm64"]);
  });
  it("never turns native macOS or Linux jobs into emulated containers", () => {
    const native = { ...runner, mode: "native" as const, image: null };
    const verified = { ...host, dockerPlatforms: ["linux/arm64"] as ["linux/arm64"] };
    expect(actionRunnerMismatch(verified, native, arm)).toContain("arm64");
    expect(actionContainerPlatform(verified, native, { labels: [] })).toBeUndefined();
    expect(
      actionRunnerMismatch(verified, runner, { labels: ["macos-latest"], requiresDocker: false }),
    ).toContain("macos");
  });
  it("rejects contradictory architecture labels rather than selecting one arbitrarily", () => {
    expect(
      actionRunnerMismatch(host, runner, { labels: ["x64", "ARM64"], requiresDocker: false }),
    ).toContain("matrix");
  });
});
