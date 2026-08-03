import { describe, it, expect } from "vitest";
import { buildSingleModeSnapshot } from "./mode-config";
import type { DeploymentConfig } from "./types";

/**
 * #389: the scan omits `packageManager` when the source has none — a stock
 * Compose project carries neither a manifest nor a lockfile. The snapshot is
 * persisted through `POST /projects/ensure`, whose `packageManager` is drawn
 * from the real package-manager list, so an absent value has to resolve to a
 * real one here rather than travel as undefined.
 */
describe("buildSingleModeSnapshot — compose primary without a package manager", () => {
  const config = {
    projectType: "services",
    projectName: "immich",
    repo: "immich",
    services: [],
    publicEndpoints: [],
    buildStrategy: "auto",
    options: {
      productionPort: "",
      rootDirectory: "./",
      installCommand: "",
      buildCommand: "",
      startCommand: "",
      outputDirectory: "",
      productionPaths: "",
      hasServer: false,
      hasBuild: false,
    },
    singleAppCandidate: {
      stack: "docker-compose",
      projectType: "services",
      category: "docker",
      // No packageManager: this is exactly what the scan now returns.
      buildCommand: "",
      installCommand: "",
      startCommand: "",
      buildImage: "node:22",
      outputDirectory: "dist",
      rootDirectory: "./",
      productionPaths: [],
      port: 2283,
      hasServer: false,
      hasBuild: false,
    },
  } as unknown as DeploymentConfig;

  it("falls back to npm instead of carrying an absent package manager", () => {
    const snapshot = buildSingleModeSnapshot(config);

    expect(snapshot?.packageManager).toBe("npm");
  });
});
