import { describe, expect, it } from "vitest";
import {
  mountedReleaseHealthPort,
  mountedReleaseHostRoot,
  mountedReleaseVolume,
  resolveMountedReleaseRuntimeTarget,
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

const mount = "/var/lib/openship/mounted-releases/proj_demo:/srv/demo";

describe("mounted release config", () => {
  it("derives one stable host root and does not remount the root read-only", () => {
    expect(mountedReleaseHostRoot(project.id)).toBe("/var/lib/openship/mounted-releases/proj_demo");
    expect(mountedReleaseVolume(project as never)).toBe(mount);
    expect(mountedReleaseVolume(project as never)).not.toMatch(/:ro$/);
    const once = withMountedReleaseVolume(project as never, ["data:/data"]);
    expect(withMountedReleaseVolume(project as never, once)).toEqual(once);
  });

  it("mounts only the selected compose service and accepts an omitted volume list", () => {
    const services = withMountedReleaseServiceVolume(
      project as never,
      [{ name: "app" }, { name: "database", volumes: ["db:/var/lib/postgresql/data"] }] as never,
    );
    expect(services[0]?.volumes).toEqual([mount]);
    expect(services[1]?.volumes).toEqual(["db:/var/lib/postgresql/data"]);
  });

  it("leaves runtime volumes unchanged while the feature is disabled", () => {
    const disabled = { ...project, mountedRelease: { ...project.mountedRelease, enabled: false } };
    expect(withMountedReleaseVolume(disabled as never, ["data:/data"])).toEqual(["data:/data"]);
  });

  it("falls back to name when compose services have no row id yet", () => {
    const pinned = {
      ...project,
      mountedRelease: { ...project.mountedRelease, serviceId: "svc_app", serviceName: "app" },
    };
    const services = withMountedReleaseServiceVolume(
      pinned as never,
      [{ name: "app" }, { name: "database" }] as never,
    );
    expect(services[0]?.volumes).toEqual([mount]);
    expect(services[1]?.volumes).toBeUndefined();
  });

  it("does not retarget the mount after a compose service rename when serviceId is set", () => {
    const pinned = {
      ...project,
      mountedRelease: {
        ...project.mountedRelease,
        serviceId: "svc_app",
        serviceName: "app",
      },
    };
    const services = withMountedReleaseServiceVolume(
      pinned as never,
      [
        { id: "svc_app", name: "web" },
        { id: "svc_db", name: "app", volumes: ["db:/var/lib/postgresql/data"] },
      ] as never,
    );
    expect(services[0]?.volumes).toEqual([mount]);
    expect(services[1]?.volumes).toEqual(["db:/var/lib/postgresql/data"]);
  });

  it("matches a name-only legacy config by service name", () => {
    const services = withMountedReleaseServiceVolume(
      project as never,
      [
        { id: "svc_app", name: "app" },
        { id: "svc_db", name: "database" },
      ] as never,
    );
    expect(services[0]?.volumes).toEqual([mount]);
    expect(services[1]?.volumes).toBeUndefined();
  });

  it("targets reload and health at the configured service, not the compose primary", () => {
    const renamed = { id: "svc_app", name: "web", enabled: true };
    const stack = [
      { id: "svc_db", name: "database", enabled: true },
      renamed,
    ];
    expect(
      resolveMountedReleaseRuntimeTarget({ serviceId: "svc_app", serviceName: "app" }, stack),
    ).toEqual({ ok: true, mode: "service", service: renamed });
    expect(resolveMountedReleaseRuntimeTarget({ serviceName: "web" }, stack)).toEqual({
      ok: true,
      mode: "service",
      service: renamed,
    });
  });

  it("defaults the health probe port from the targeted service", () => {
    expect(
      mountedReleaseHealthPort(
        { mode: "service", service: { exposedPort: "8080", ports: ["3000"] } },
        3000,
      ),
    ).toBe(8080);
    expect(
      mountedReleaseHealthPort({ mode: "service", service: { ports: ["9090:9090"] } }, 3000),
    ).toBe(9090);
    expect(mountedReleaseHealthPort({ mode: "primary" }, 3000)).toBe(3000);
  });

  it("refuses a missing or disabled compose target and keeps single-app on primary", () => {
    expect(resolveMountedReleaseRuntimeTarget({}, [])).toEqual({ ok: true, mode: "primary" });
    expect(
      resolveMountedReleaseRuntimeTarget(
        { serviceName: "app" },
        [{ id: "svc_app", name: "app", enabled: false }],
      ),
    ).toEqual({ ok: false, reason: "disabled" });
    expect(
      resolveMountedReleaseRuntimeTarget(
        { serviceId: "svc_gone" },
        [{ id: "svc_app", name: "app", enabled: true }],
      ),
    ).toEqual({ ok: false, reason: "missing" });
  });
});
