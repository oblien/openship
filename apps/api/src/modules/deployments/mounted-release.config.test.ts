import { describe, expect, it } from "vitest";
import {
  activeCodeReleaseDeploymentId,
  mountedReleaseHostRoot,
  mountedReleaseVolume,
  withMountedReleaseServiceVolume,
  withMountedReleaseVolume,
} from "./mounted-release.config";

const project = {
  id: "proj_demo",
  mountedRelease: {
    enabled: true,
    serviceName: "app",
    containerPath: "/srv/demo",
  },
};

describe("mounted release config", () => {
  it("derives one stable host root and does not duplicate the app mount", () => {
    expect(mountedReleaseHostRoot(project.id)).toBe("/var/lib/openship/mounted-releases/proj_demo");
    expect(mountedReleaseVolume(project as never)).toBe(
      "/var/lib/openship/mounted-releases/proj_demo:/srv/demo",
    );
    const once = withMountedReleaseVolume(project as never, ["data:/data"]);
    expect(withMountedReleaseVolume(project as never, once)).toEqual(once);
  });

  it("mounts only the selected compose service and accepts an omitted volume list", () => {
    const services = withMountedReleaseServiceVolume(
      project as never,
      [{ name: "app" }, { name: "database", volumes: ["db:/var/lib/postgresql/data"] }] as never,
    );
    expect(services[0]?.volumes).toEqual([
      "/var/lib/openship/mounted-releases/proj_demo:/srv/demo",
    ]);
    expect(services[1]?.volumes).toEqual(["db:/var/lib/postgresql/data"]);
  });

  it("leaves runtime volumes unchanged while the feature is disabled", () => {
    const disabled = { ...project, mountedRelease: { ...project.mountedRelease, enabled: false } };
    expect(withMountedReleaseVolume(disabled as never, ["data:/data"])).toEqual(["data:/data"]);
  });

  it("exposes the code pointer only while mounted releases are enabled", () => {
    const live = { ...project, activeReleaseDeploymentId: "dep_code" };
    expect(activeCodeReleaseDeploymentId(live as never)).toBe("dep_code");
    const off = {
      ...project,
      mountedRelease: { ...project.mountedRelease, enabled: false },
      activeReleaseDeploymentId: "dep_code",
    };
    expect(activeCodeReleaseDeploymentId(off as never)).toBeNull();
  });
});
