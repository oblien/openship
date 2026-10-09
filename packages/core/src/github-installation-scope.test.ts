import { describe, expect, it } from "vitest";
import {
  matchesGitHubInstallationScope,
  validateGitHubInstallationScope,
} from "./github-installation-scope";
import { actionRunnerMismatch } from "./action-capabilities";
import type { ActionCapabilities, ActionRunnerConfig } from "./actions";

describe("Actions credential and destination boundaries", () => {
  it("accepts only the requested repository and permissions, allowing implicit read-only metadata", () => {
    const scope = validateGitHubInstallationScope(["App", "app"], { contents: "read" });
    expect(scope.repositories).toEqual(["app"]);
    expect(
      matchesGitHubInstallationScope(scope, {
        repositories: ["App"],
        permissions: { contents: "read", metadata: "read" },
      }),
    ).toBe(true);
    for (const actual of [
      undefined,
      { repositories: ["app", "other"], permissions: scope.permissions },
      { repositories: ["app"], permissions: { contents: "write" } },
      { repositories: ["app"], permissions: { administration: "write", contents: "read" } },
      { repositories: ["app"], permissions: {} },
    ])
      expect(matchesGitHubInstallationScope(scope, actual)).toBe(false);
    for (const permission of [
      "administration",
      "members",
      "organization_administration",
      "metadata",
    ])
      expect(() => validateGitHubInstallationScope(["app"], { [permission]: "write" })).toThrow();
    for (const repos of [[], ["../other"], ["owner/app"], ["*"]])
      expect(() => validateGitHubInstallationScope(repos, {})).toThrow();
  });
  it("rejects stale platform labels when an existing server changes capabilities", () => {
    const linux: ActionCapabilities = {
      os: "linux",
      architecture: "x64",
      docker: true,
      git: true,
      node: true,
      distribution: "ubuntu",
      version: "24.04",
    };
    const config: ActionRunnerConfig = {
      mode: "native",
      labels: ["macos-latest"],
      image: null,
      cpu: 1,
      memoryMb: 1024,
      maxParallel: 1,
      allowDockerSocket: false,
    };
    expect(
      actionRunnerMismatch(linux, config, { labels: ["macos-latest"], requiresDocker: false }),
    ).toContain("capabilities");
    expect(
      actionRunnerMismatch(
        linux,
        { ...config, labels: ["arm64"] },
        { labels: ["arm64"], requiresDocker: false },
      ),
    ).toContain("capabilities");
    expect(
      actionRunnerMismatch(
        { ...linux, node: false },
        { ...config, labels: [] },
        { labels: ["linux"], requiresDocker: false },
      ),
    ).toContain("Node.js");
  });
});
