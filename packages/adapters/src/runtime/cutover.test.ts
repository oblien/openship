import { describe, expect, it } from "vitest";

import {
  clashingRwDestinations,
  decideCutover,
  hasHostPortBindings,
  newcomerName,
  parseSharedVolumeOptIn,
  rwVolumeDest,
  type CutoverInput,
} from "./cutover";

const BASE: CutoverInput = {
  incumbentRunning: true,
  incumbentMounts: [{ Type: "volume", Name: "data", Destination: "/data", RW: true }],
  ports: ["3000"],
  volumes: ["data:/data"],
  slug: "shop",
  serviceName: "web",
  sharedOptIn: new Set<string>(),
  resources: { cpuCores: 0.5, memoryMb: 512 },
  capacity: { availableCpuCores: 1, availableMemoryMb: 1024 },
};

const stateless = (overrides: Partial<CutoverInput> = {}): CutoverInput => ({
  ...BASE,
  incumbentMounts: [],
  volumes: [],
  ...overrides,
});

describe("cutover helpers", () => {
  it("treats only explicit host publishes as port collisions", () => {
    expect(hasHostPortBindings(["3000", "3000/tcp"])).toBe(false);
    expect(hasHostPortBindings(["8080:3000"])).toBe(true);
    expect(hasHostPortBindings(["127.0.0.1:8080:3000/tcp"])).toBe(true);
    expect(hasHostPortBindings(["[::1]:8080:3000"])).toBe(true);
  });

  it("uses the shared mount parser and normalizes container destinations", () => {
    expect(rwVolumeDest("data:/data")).toBe("/data");
    expect(rwVolumeDest("/srv/x:/app/x/:rw")).toBe("/app/x");
    expect(rwVolumeDest("data:/data:z")).toBe("/data");
    expect(rwVolumeDest("/srv/x:/app/x:rshared")).toBe("/app/x");
    expect(rwVolumeDest("data:/data/../data")).toBe("/data");
    expect(rwVolumeDest("/anonymous")).toBe("/anonymous");
    expect(rwVolumeDest("data:/data:ro")).toBeNull();
    expect(rwVolumeDest("/srv/x:/data:ro,rprivate")).toBeNull();
    expect(rwVolumeDest("data:relative")).toBeNull();
  });

  it("parses exact opt-in keys and ignores malformed entries", () => {
    const set = parseSharedVolumeOptIn(
      " shop/web:/data,\n other/app:/cache/ bad-entry shop:/x /y ",
    );
    expect([...set].sort()).toEqual(["other/app:/cache", "shop/web:/data"]);
    expect(parseSharedVolumeOptIn(undefined).size).toBe(0);
    expect(parseSharedVolumeOptIn("").size).toBe(0);
  });

  it("replaces a shared writable named volume without opt-in", () => {
    expect(decideCutover(BASE)).toEqual({
      mode: "replace",
      reason: "shared-rw-volume",
      clashes: ["/data"],
    });
  });

  it("uses the resolved anonymous or image-declared persistent volume identity", () => {
    const incumbentMounts = [
      { Type: "volume", Name: "old-anonymous", Destination: "/data", RW: true },
    ];
    expect(decideCutover({ ...BASE, incumbentMounts, volumes: ["old-anonymous:/data"] })).toEqual({
      mode: "replace",
      reason: "shared-rw-volume",
      clashes: ["/data"],
    });
    expect(
      decideCutover({ ...BASE, incumbentMounts, volumes: ["old-anonymous:/new-data"] }),
    ).toEqual({
      mode: "replace",
      reason: "shared-rw-volume",
      clashes: ["/new-data"],
    });
  });

  it("does not infer shared storage merely from matching container destinations", () => {
    expect(decideCutover({ ...BASE, volumes: ["different-data:/data"] })).toEqual({
      mode: "overlap",
    });
  });

  it("allows an exact shared-volume opt-in when capacity is sufficient", () => {
    expect(
      decideCutover({ ...BASE, sharedOptIn: parseSharedVolumeOptIn("shop/web:/data") }),
    ).toEqual({ mode: "overlap" });
  });

  it("scopes opt-in to the project, service and normalized candidate destination", () => {
    for (const entry of ["shop/worker:/data", "other/web:/data", "shop/web:/data/sub"]) {
      expect(decideCutover({ ...BASE, sharedOptIn: parseSharedVolumeOptIn(entry) }).mode).toBe(
        "replace",
      );
    }
    expect(
      decideCutover({ ...BASE, sharedOptIn: parseSharedVolumeOptIn("shop/web:/data/../data/") }),
    ).toEqual({ mode: "overlap" });
  });

  it("requires every shared writable candidate mount to be opted in", () => {
    const opts: CutoverInput = {
      ...BASE,
      incumbentMounts: [
        ...BASE.incumbentMounts,
        { Type: "volume", Name: "cache", Destination: "/cache", RW: true },
      ],
      volumes: ["data:/data", "cache:/cache"],
      sharedOptIn: parseSharedVolumeOptIn("shop/web:/data"),
    };
    expect(clashingRwDestinations(opts)).toEqual(["/cache"]);
    expect(decideCutover(opts)).toEqual({
      mode: "replace",
      reason: "shared-rw-volume",
      clashes: ["/cache"],
    });
  });

  it.each(["", ":rw", ":rshared", ":rw,rprivate", ":z,rslave"])(
    "blocks a shared host bind with supported options %s",
    (options) => {
      const opts = {
        ...BASE,
        incumbentMounts: [{ Type: "bind", Source: "/srv/data", Destination: "/data", RW: true }],
        volumes: [`/srv/data:/new-data${options}`],
      };
      expect(decideCutover(opts)).toEqual({
        mode: "replace",
        reason: "shared-rw-volume",
        clashes: ["/new-data"],
      });
    },
  );

  it.each(["/srv/data/sub", "/srv", "/srv/data/../data/", "/"])(
    "blocks overlapping writable bind source %s",
    (source) => {
      expect(
        decideCutover({
          ...BASE,
          incumbentMounts: [{ Type: "bind", Source: "/srv/data", Destination: "/old", RW: true }],
          volumes: [`${source}:/new`],
        }),
      ).toEqual({ mode: "replace", reason: "shared-rw-volume", clashes: ["/new"] });
    },
  );

  it("does not confuse a sibling bind path with a shared directory", () => {
    expect(
      decideCutover({
        ...BASE,
        incumbentMounts: [{ Type: "bind", Source: "/srv/data", Destination: "/data", RW: true }],
        volumes: ["/srv/database:/data"],
      }),
    ).toEqual({ mode: "overlap" });
  });

  it("recognizes a bind into the incumbent named volume's actual source", () => {
    expect(
      decideCutover({
        ...BASE,
        incumbentMounts: [
          {
            Type: "volume",
            Name: "data",
            Source: "/var/lib/docker/volumes/data/_data",
            Destination: "/data",
            RW: true,
          },
        ],
        volumes: ["/var/lib/docker/volumes/data/_data:/other"],
      }),
    ).toEqual({ mode: "replace", reason: "shared-rw-volume", clashes: ["/other"] });
  });

  it("allows read-only sharing without the writable-storage opt-in", () => {
    expect(decideCutover({ ...BASE, volumes: ["data:/data:ro,rshared"] })).toEqual({
      mode: "overlap",
    });
    expect(
      decideCutover({ ...BASE, incumbentMounts: [{ ...BASE.incumbentMounts[0]!, RW: false }] }),
    ).toEqual({ mode: "overlap" });
  });

  it("does not assume an unreported writable flag means read-only", () => {
    expect(
      decideCutover({
        ...BASE,
        incumbentMounts: [{ Type: "volume", Name: "data", Destination: "/data" }],
      }).mode,
    ).toBe("replace");
  });

  it("treats independent tmpfs mounts as nonpersistent storage", () => {
    expect(
      decideCutover({
        ...BASE,
        incumbentMounts: [{ Type: "tmpfs", Destination: "/data", RW: true }],
        volumes: ["new-data:/data"],
      }),
    ).toEqual({ mode: "overlap" });
  });

  it.each(["/data", "./relative:/data", "data:relative", "data:/data:unknown"])(
    "refuses overlap when a candidate mount is unresolved or invalid: %s",
    (volume) => {
      expect(decideCutover({ ...BASE, volumes: [volume] })).toEqual({
        mode: "replace",
        reason: "storage-unverified",
      });
    },
  );

  it("refuses overlap with unverified incumbent storage even when the destination is opted in", () => {
    expect(
      decideCutover({
        ...BASE,
        incumbentMounts: [{ Destination: "/data", RW: true }],
        sharedOptIn: parseSharedVolumeOptIn("shop/web:/data"),
      }),
    ).toEqual({ mode: "replace", reason: "storage-unverified" });
  });

  it("does not infer a named volume's identity from an unnamed Docker storage path", () => {
    expect(
      decideCutover({
        ...BASE,
        incumbentMounts: [
          {
            Type: "volume",
            Source: "/var/lib/docker/volumes/data/_data",
            Destination: "/data",
            RW: true,
          },
        ],
      }),
    ).toEqual({ mode: "replace", reason: "storage-unverified" });
  });

  it("never overlaps explicit host port bindings, including with storage opt-in", () => {
    expect(
      decideCutover({
        ...BASE,
        ports: ["8080:3000"],
        sharedOptIn: parseSharedVolumeOptIn("shop/web:/data"),
      }),
    ).toEqual({ mode: "replace", reason: "host-ports" });
  });

  it("replaces when there is no running incumbent", () => {
    expect(decideCutover({ ...BASE, incumbentRunning: false })).toEqual({
      mode: "replace",
      reason: "no-incumbent",
    });
  });

  it.each([
    { networkMode: "container:vpn" },
    { networkMode: "none" },
    { networkMode: "host" },
    { pidMode: "container:provider" },
  ])("does not overlap shared or special namespaces: %j", (namespaces) => {
    expect(decideCutover(stateless(namespaces))).toEqual({
      mode: "replace",
      reason: "shared-namespaces",
    });
  });

  it("does not overlap an exclusive device workload", () => {
    expect(decideCutover(stateless({ hasDevices: true }))).toEqual({
      mode: "replace",
      reason: "devices",
    });
  });

  it.each([
    undefined,
    {},
    { cpuCores: 0.5 },
    { memoryMb: 512 },
    { cpuCores: 0, memoryMb: 512 },
    { cpuCores: 0.5, memoryMb: 0 },
    { cpuCores: -1, memoryMb: 512 },
    { cpuCores: 0.5, memoryMb: Number.NaN },
    { cpuCores: Number.POSITIVE_INFINITY, memoryMb: 512 },
  ])("preserves uncapped/unknown candidate settings and uses replacement: %j", (resources) => {
    const input = stateless({ resources });
    expect(decideCutover(input)).toEqual({ mode: "replace", reason: "resources-unconfigured" });
    expect(input.resources).toBe(resources);
  });

  it.each([
    undefined,
    { availableCpuCores: Number.NaN, availableMemoryMb: 1024 },
    { availableCpuCores: 1, availableMemoryMb: -1 },
    { availableCpuCores: Number.POSITIVE_INFINITY, availableMemoryMb: 1024 },
  ])("keeps replacement when fresh matching-target capacity is unavailable: %j", (capacity) => {
    expect(decideCutover(stateless({ capacity }))).toEqual({
      mode: "replace",
      reason: "capacity-unavailable",
    });
  });

  it.each([
    { availableCpuCores: 0.49, availableMemoryMb: 1024 },
    { availableCpuCores: 1, availableMemoryMb: 511 },
    { availableCpuCores: 0, availableMemoryMb: 0 },
  ])("keeps replacement when either configured resource cannot fit: %j", (capacity) => {
    expect(decideCutover(stateless({ capacity }))).toEqual({
      mode: "replace",
      reason: "insufficient-capacity",
    });
  });

  it("allows overlap only with verified storage and sufficient resource headroom", () => {
    expect(decideCutover(stateless())).toEqual({ mode: "overlap" });
    expect(
      decideCutover(stateless({ capacity: { availableCpuCores: 0.5, availableMemoryMb: 512 } })),
    ).toEqual({ mode: "overlap" });
  });

  it("does not let a volume opt-in bypass insufficient capacity", () => {
    expect(
      decideCutover({
        ...BASE,
        sharedOptIn: parseSharedVolumeOptIn("shop/web:/data"),
        capacity: { availableCpuCores: 1, availableMemoryMb: 256 },
      }),
    ).toEqual({ mode: "replace", reason: "insufficient-capacity" });
  });

  it("builds a newcomer name that cannot collide with the stable name", () => {
    expect(newcomerName({ deploymentId: "dep_AbC-123", serviceName: "web" })).toBe(
      "openship-cutover-depAbC123-web",
    );
  });
});
