import { describe, expect, it } from "vitest";
import { RELEASE_PRESET_IDS } from "@repo/core";
import type { MountedReleaseConfig } from "./mounted-release.config";
import { mountedReleaseFromPreset } from "./presets";

function assertValidConfig(config: MountedReleaseConfig) {
  expect(config.enabled).toBe(true);
  expect(config.containerPath.startsWith("/")).toBe(true);
  expect(config.containerPath.length).toBeGreaterThan(1);
  if (config.healthPath) expect(config.healthPath.startsWith("/")).toBe(true);
  expect(["prebuilt", "server", "upload"]).toContain(config.buildMode);
  expect(["image", "dockerfile", "compose"]).toContain(config.runtimeInstall);
  for (const path of config.sharedPaths ?? []) {
    expect(path.length).toBeGreaterThan(0);
    expect(path.startsWith("/")).toBe(false);
  }
}

describe("release presets", () => {
  it("fills a valid MountedReleaseConfig for every preset", () => {
    for (const id of RELEASE_PRESET_IDS) {
      const config = mountedReleaseFromPreset(id);
      assertValidConfig(config);
      expect(config.preset).toBe(id);
    }
  });

  it("Laravel is a PHP code release with /up, storage, and migrate/optimize phases", () => {
    const config = mountedReleaseFromPreset("laravel");
    expect(config.buildMode).toBe("prebuilt");
    expect(config.healthPath).toBe("/up");
    expect(config.sharedPaths).toEqual(expect.arrayContaining(["storage", "bootstrap/cache"]));
    expect(config.prepareCommand).toMatch(/migrate --force/);
    expect(config.prepareCommand).toMatch(/optimize/);
  });

  it("static Next is git-prebuilt with / and no prepare", () => {
    const config = mountedReleaseFromPreset("next-static");
    expect(config.buildMode).toBe("prebuilt");
    expect(config.healthPath).toBe("/");
    expect(config.prepareCommand).toBeUndefined();
  });

  it("Node defaults to server prepare and can save upload", () => {
    const config = mountedReleaseFromPreset("node");
    expect(config.buildMode).toBe("server");
    expect(config.prepareCommand).toBe("npm ci && npm run build");
    expect(config.healthPath).toBe("/");
    expect(mountedReleaseFromPreset("node", { buildMode: "upload" }).buildMode).toBe("upload");
  });

  it("Compose targets a stable runtime rebuild contract", () => {
    const config = mountedReleaseFromPreset("compose", { serviceId: "svc_app", serviceName: "app" });
    expect(config.runtimeInstall).toBe("compose");
    expect(config.serviceId).toBe("svc_app");
    expect(config.buildMode).toBe("prebuilt");
  });
});
