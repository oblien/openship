import { describe, expect, it } from "vitest";
import { validateClusterStorage, validateClusterVolumeMounts } from "./cluster-storage";

describe("shared storage admission", () => {
  const disks = ["a", "b", "c"].map((serverId) => ({
    serverId,
    path: "/var/lib/openship/storage",
    reservedGiB: 5,
  }));
  it("requires independent hosts for every requested data copy", () => {
    expect(() => validateClusterStorage({ replicas: 3, disks })).not.toThrow();
    expect(() => validateClusterStorage({ replicas: 3, disks: disks.slice(0, 2) })).toThrow(
      /distinct/,
    );
    expect(() => validateClusterStorage({ replicas: 2, disks: [disks[0], disks[0]] })).toThrow(
      /distinct/,
    );
  });
  it.each(["/etc/data", "/proc/disk", "/var/lib/../storage", "/var//storage", "/", "./data"])(
    "refuses unsafe host directory %s",
    (path) => {
      expect(() =>
        validateClusterStorage({ replicas: 2, disks: disks.map((disk) => ({ ...disk, path })) }),
      ).toThrow(/dedicated/);
    },
  );
  it("does not let a shared mount hide system files or another volume", () => {
    expect(() =>
      validateClusterVolumeMounts([{ name: "uploads", mountPath: "/app/uploads" }]),
    ).not.toThrow();
    for (const mountPath of ["/etc", "/var/../etc", "/usr/bin", "/app//uploads", "/app/"])
      expect(() => validateClusterVolumeMounts([{ name: "uploads", mountPath }])).toThrow();
    expect(() =>
      validateClusterVolumeMounts([
        { name: "uploads", mountPath: "/app" },
        { name: "images", mountPath: "/app/images" },
      ]),
    ).toThrow(/hide/);
  });
});
