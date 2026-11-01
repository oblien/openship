import { describe, expect, it } from "vitest";
import type { Deployment, Project } from "@repo/db";
import {
  createBuildConfig,
  createDockerfileBuildConfig,
  createMonorepoSourceBuildConfig,
  type BuildConfigSnapshotLike,
} from "@repo/platform/engine/modules/deployments/build-config";

const snapshot: BuildConfigSnapshotLike = {
  repoUrl: "https://github.com/acme/app.git",
  branch: "main",
  framework: "php",
  buildImage: "php:8.4-cli",
  runtimeImage: "php:8.4-fpm",
  packageManager: "composer",
  installCommand: "composer install",
  buildCommand: "",
  outputDirectory: "",
  productionPaths: [],
  rootDirectory: "",
  port: 8080,
  startCommand: "php -S 0.0.0.0:8080",
  hasServer: true,
  hasBuild: true,
};

describe.each([
  ["single app", createBuildConfig],
  ["Dockerfile service", createDockerfileBuildConfig],
  ["generated monorepo service", createMonorepoSourceBuildConfig],
] as const)("%s base image refresh", (_name, createConfig) => {
  it.each([
    { trigger: "manual", forcePullImages: undefined, expected: false },
    { trigger: "redeploy", forcePullImages: undefined, expected: false },
    { trigger: "manual", forcePullImages: true, expected: true },
    { trigger: "webhook", forcePullImages: true, expected: true },
    { trigger: "update", forcePullImages: undefined, expected: true },
    { trigger: "rollback", forcePullImages: true, expected: false },
  ])(
    "uses deployment intent for $trigger (force pull: $forcePullImages)",
    ({ trigger, forcePullImages, expected }) => {
      const config = createConfig({
        project: { id: "project-1", slug: "php-app" } as Project,
        dep: { branch: "main", trigger } as Deployment,
        snapshot: { ...snapshot, forcePullImages },
        sessionId: "build-1",
        envVars: {},
        resources: { cpuCores: 0, memoryMb: 0, diskMb: 0 },
        // Per-service configuration cannot override this run's update/rollback intent.
        overrides: { refreshBaseImages: !expected },
      });
      expect(config.refreshBaseImages).toBe(expected);
    },
  );
});
