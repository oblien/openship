import { describe, expect, it } from "vitest";
import { formatVolumeMount, parseVolumeMount, parseVolumeSpec } from "./volume-spec";

describe("editing service mounts without losing their storage or options", () => {
  it.each([
    ["data:/app/data:rw,cached", "data", "/app/data", ["rw", "cached"], "named"],
    ["../files:/files:ro,z", "../files", "/files", ["ro", "z"], "bind"],
    ["~/config:/config:ro", "~/config", "/config", ["ro"], "bind"],
    ["/cache", "", "/cache", [], "anonymous"],
    ["/cache:ro", "", "/cache", ["ro"], "anonymous"],
  ] as const)("retains the meaning of %s", (spec, source, target, options, kind) => {
    expect(parseVolumeMount(spec)).toEqual({ source, target, options: [...options] });
    expect(parseVolumeSpec(spec)).toEqual({
      raw: spec,
      source,
      target,
      kind,
      readOnly: (options as readonly string[]).includes("ro"),
    });
    expect(formatVolumeMount(parseVolumeMount(spec))).toBe(spec);
  });

  it("changes only the requested path and preserves every existing option", () => {
    const original = parseVolumeMount("data:/app/data:rw,cached,Z");
    expect(formatVolumeMount({ ...original, target: " /app/files " })).toBe(
      "data:/app/files:rw,cached,Z",
    );
    expect(formatVolumeMount({ ...original, source: " /srv/files " })).toBe(
      "/srv/files:/app/data:rw,cached,Z",
    );
  });
});
