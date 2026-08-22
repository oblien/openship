import { beforeEach, describe, expect, it, vi } from "vitest";

const resolveLatestVersionMock = vi.hoisted(() => vi.fn());
const resolveReleaseDistMock = vi.hoisted(() => vi.fn());

vi.mock("../../../src/lib/release-resolver", () => ({
  resolveLatestVersion: resolveLatestVersionMock,
  resolveReleaseDist: resolveReleaseDistMock,
  readApiVersion: () => "0.6.6",
}));

import { applyReleaseSourceToSnapshot } from "../../../src/modules/deployments/build.service";
import type { Project } from "@repo/db";
import type { DeploymentConfigSnapshot } from "../../../src/modules/deployments/build.service";


beforeEach(() => {
  vi.clearAllMocks();
});
describe("applyReleaseSourceToSnapshot for container releases", () => {
  const baseProject = (over: Partial<Project> = {}): Project =>
    ({
      id: "proj_fredy",
      name: "fredy",
      slug: "fredy",
      organizationId: "org_1",
      gitProvider: "github",
      gitOwner: "orangecoding",
      gitRepo: "fredy",
      gitBranch: "26.6.0",
      buildImage: "ghcr.io/orangecoding/fredy:26.6.0",
      sourceKind: "image",
      buildKind: "prebuilt",
      hasServer: true,
      hasBuild: false,
      releaseSource: {
        mode: "github",
        repo: "orangecoding/fredy",
      },
      ...over,
    }) as Project;

  const baseSnapshot = (over: Partial<DeploymentConfigSnapshot> = {}): DeploymentConfigSnapshot =>
    ({
      framework: "docker",
      buildImage: "ghcr.io/orangecoding/fredy:26.6.0",
      runtimeImage: "ubuntu:22.04",
      packageManager: "npm",
      installCommand: "",
      buildCommand: "",
      startCommand: "",
      port: 9998,
      volumes: ["/conf", "/db"],
      hasBuild: false,
      hasServer: true,
      ...over,
    }) as DeploymentConfigSnapshot;

  it("updates buildImage tag with resolved release version and skips dist download", async () => {
    resolveLatestVersionMock.mockResolvedValue("26.7.0");
    const project = baseProject();
    const snapshot = baseSnapshot();

    const version = await applyReleaseSourceToSnapshot(project, snapshot);

    expect(version).toBe("26.7.0");
    expect(snapshot.releaseVersion).toBe("26.7.0");
    expect(snapshot.buildImage).toBe("ghcr.io/orangecoding/fredy:26.7.0");
    expect(snapshot.releaseRepo).toBe("orangecoding/fredy");
    expect(snapshot.localPath).toBeFalsy();
    expect(resolveReleaseDistMock).not.toHaveBeenCalled();
  });

  it("uses imageTemplate when specified in releaseSource", async () => {
    resolveLatestVersionMock.mockResolvedValue("26.7.0");
    const project = baseProject({
      releaseSource: {
        mode: "github",
        repo: "orangecoding/fredy",
        imageTemplate: "ghcr.io/orangecoding/fredy:{version}",
      },
    });
    const snapshot = baseSnapshot({ buildImage: "node:22" });

    const version = await applyReleaseSourceToSnapshot(project, snapshot);

    expect(version).toBe("26.7.0");
    expect(snapshot.buildImage).toBe("ghcr.io/orangecoding/fredy:26.7.0");
    expect(resolveReleaseDistMock).not.toHaveBeenCalled();
  });

  it("substitutes version in compose service images", async () => {
    resolveLatestVersionMock.mockResolvedValue("26.7.0");
    const project = baseProject();
    const snapshot = baseSnapshot({
      composeServices: [
        {
          name: "app",
          image: "ghcr.io/orangecoding/fredy:{version}",
          env: {},
          volumes: [],
          portMappings: [],
        },
      ],
    });

    await applyReleaseSourceToSnapshot(project, snapshot);

    expect(snapshot.composeServices?.[0]?.image).toBe("ghcr.io/orangecoding/fredy:26.7.0");
    expect(resolveReleaseDistMock).not.toHaveBeenCalled();
  });

  it("still downloads dist when assetTemplate is present", async () => {
    resolveLatestVersionMock.mockResolvedValue("1.0.0");
    resolveReleaseDistMock.mockResolvedValue({
      dir: "/cache/dist/v1.0.0",
      version: "1.0.0",
      asset: "app-v1.0.0-linux-amd64.tar.gz",
      origin: "downloaded",
    });

    const project = baseProject({
      gitProvider: "release",
      sourceKind: null,
      buildKind: null,
      buildImage: null,
      releaseSource: {
        mode: "github",
        repo: "oblien/openship",
        assetTemplate: "openship-{tag}-{os}-{arch}.tar.gz",
      },
    });
    const snapshot = baseSnapshot({ buildImage: "" });

    const version = await applyReleaseSourceToSnapshot(project, snapshot);

    expect(version).toBe("1.0.0");
    expect(snapshot.localPath).toBe("/cache/dist/v1.0.0");
    expect(snapshot.releaseAsset).toBe("app-v1.0.0-linux-amd64.tar.gz");
    expect(resolveReleaseDistMock).toHaveBeenCalledTimes(1);
  });
});
