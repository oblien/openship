import { describe, expect, it } from "vitest";
import {
  BindMountCollisionError,
  mountedReleaseHostRoot,
  mountedReleaseVolume,
  volumeMountTarget,
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

  it("parses the container dest out of a compose volume spec", () => {
    expect(volumeMountTarget("data:/data")).toBe("/data");
    expect(volumeMountTarget("/host/app:/srv/demo:ro")).toBe("/srv/demo");
    expect(volumeMountTarget("/host/app:/srv/demo:ro,z")).toBe("/srv/demo");
    expect(volumeMountTarget("/host/app:/srv/demo:rw,cached")).toBe("/srv/demo");
    expect(volumeMountTarget("/srv/demo")).toBe("/srv/demo");
  });

  it("refuses a second bind to the same container dest", () => {
    expect(() =>
      withMountedReleaseVolume(project as never, ["existing:/srv/demo:ro"]),
    ).toThrow(BindMountCollisionError);
    expect(() =>
      withMountedReleaseVolume(project as never, ["existing:/srv/demo:ro,z"]),
    ).toThrow(/already bound/);
    expect(() =>
      withMountedReleaseVolume(project as never, ["existing:/srv/demo/"]),
    ).toThrow(/already bound/);
  });

  it("still no-ops when the generated mount is already present", () => {
    const once = withMountedReleaseVolume(project as never, ["data:/data"]);
    expect(withMountedReleaseVolume(project as never, once)).toEqual(once);
  });
});
