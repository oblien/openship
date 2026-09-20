import { describe, expect, it, vi } from "vitest";

import { DockerRuntime } from "./docker";

function runtimeWithDial(dial: ReturnType<typeof vi.fn>): DockerRuntime {
  const runtime = Object.create(DockerRuntime.prototype) as DockerRuntime & Record<string, unknown>;
  Object.assign(runtime, { _docker: { modem: { dial } } });
  return runtime;
}

describe("DockerRuntime.pruneBuildCache", () => {
  it("sends bounded prune policy to POST /build/prune and normalizes the result", async () => {
    const dial = vi.fn((options, callback) =>
      callback(null, { CachesDeleted: ["cache-a", "cache-b"], SpaceReclaimed: 4096 }),
    );
    const runtime = runtimeWithDial(dial);

    await expect(
      runtime.pruneBuildCache({
        all: true,
        keepStorageBytes: 5 * 1024 ** 3,
        filters: { until: ["24h"] },
      }),
    ).resolves.toEqual({ cachesDeleted: ["cache-a", "cache-b"], spaceReclaimed: 4096 });

    expect(dial).toHaveBeenCalledOnce();
    expect(dial.mock.calls[0]?.[0]).toMatchObject({
      path: "/build/prune?",
      method: "POST",
      options: {
        _query: {
          all: true,
          "keep-storage": 5 * 1024 ** 3,
          filters: { until: ["24h"] },
        },
        _body: {},
      },
    });
  });

  it("omits keep-storage for an explicit full prune", async () => {
    const dial = vi.fn((options, callback) => callback(null, { SpaceReclaimed: 0 }));
    const runtime = runtimeWithDial(dial);

    await expect(runtime.pruneBuildCache({ all: true })).resolves.toEqual({
      cachesDeleted: [],
      spaceReclaimed: 0,
    });

    expect(dial.mock.calls[0]?.[0].options._query).toEqual({ all: true });
  });

  it("rejects invalid retention values before contacting Docker", async () => {
    const dial = vi.fn();
    const runtime = runtimeWithDial(dial);

    await expect(runtime.pruneBuildCache({ keepStorageBytes: -1 })).rejects.toThrow(
      "keepStorageBytes must be a non-negative safe integer",
    );
    expect(dial).not.toHaveBeenCalled();
  });

  it("propagates daemon errors", async () => {
    const dial = vi.fn((_options, callback) => callback(new Error("daemon unavailable"), null));
    const runtime = runtimeWithDial(dial);

    await expect(runtime.pruneBuildCache({ all: true })).rejects.toThrow("daemon unavailable");
  });
});
