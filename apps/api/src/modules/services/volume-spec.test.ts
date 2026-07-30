import { describe, it, expect } from "vitest";
import { parseVolumeSpec, isHostPathSource } from "./volume-spec";

describe("parseVolumeSpec", () => {
  it("named volume with target", () => {
    expect(parseVolumeSpec("onvo-new-pgdata:/var/lib/postgresql/data")).toEqual({
      raw: "onvo-new-pgdata:/var/lib/postgresql/data",
      source: "onvo-new-pgdata",
      target: "/var/lib/postgresql/data",
      kind: "named",
      readOnly: false,
    });
  });

  it("bind mount (absolute host path) with :ro mode", () => {
    const r = parseVolumeSpec("/home/onvo-new/postgres/postgresql.conf:/etc/postgresql/postgresql.conf:ro");
    expect(r.source).toBe("/home/onvo-new/postgres/postgresql.conf");
    expect(r.target).toBe("/etc/postgresql/postgresql.conf");
    expect(r.kind).toBe("bind");
    expect(r.readOnly).toBe(true);
  });

  it("named volume with :ro is still named, readOnly true", () => {
    const r = parseVolumeSpec("cache:/data:ro");
    expect(r.kind).toBe("named");
    expect(r.readOnly).toBe(true);
    expect(r.source).toBe("cache");
    expect(r.target).toBe("/data");
  });

  it("multi-flag mode group (ro,z) sets readOnly and is stripped from target", () => {
    const r = parseVolumeSpec("/srv/app:/app:ro,z");
    expect(r.target).toBe("/app");
    expect(r.readOnly).toBe(true);
    expect(r.kind).toBe("bind");
  });

  it("rw,cached mode group → not readOnly", () => {
    const r = parseVolumeSpec("./src:/app:rw,cached");
    expect(r.kind).toBe("bind"); // ./ relative host path
    expect(r.readOnly).toBe(false);
    expect(r.target).toBe("/app");
  });

  it("anonymous volume (bare target)", () => {
    expect(parseVolumeSpec("/var/lib/data")).toEqual({
      raw: "/var/lib/data",
      source: "",
      target: "/var/lib/data",
      kind: "anonymous",
      readOnly: false,
    });
  });

  it("home-relative and explicit-relative sources classify as bind", () => {
    expect(parseVolumeSpec("~/data:/data").kind).toBe("bind");
    expect(parseVolumeSpec("./data:/app").kind).toBe("bind");
    expect(parseVolumeSpec("../shared:/app").kind).toBe("bind");
  });

  it("does not mistake a two-segment name:target for having a mode", () => {
    // 'data' is not a mode flag, so a 2-part spec keeps target intact
    const r = parseVolumeSpec("logs:/data");
    expect(r.target).toBe("/data");
    expect(r.kind).toBe("named");
    expect(r.readOnly).toBe(false);
  });
});

describe("isHostPathSource", () => {
  it("classifies host paths vs names", () => {
    expect(isHostPathSource("/abs")).toBe(true);
    expect(isHostPathSource("./rel")).toBe(true);
    expect(isHostPathSource("../rel")).toBe(true);
    expect(isHostPathSource("~/home")).toBe(true);
    expect(isHostPathSource("myvolume")).toBe(false);
    expect(isHostPathSource("onvo-new-pgdata")).toBe(false);
  });
});
