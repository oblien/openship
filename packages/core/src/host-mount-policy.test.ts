import { describe, expect, it } from "vitest";
import { findHostMountVolumes } from "./volume-spec";

describe("authored mount sources", () => {
  it.each([
    "/var/run/docker.sock:/s",
    "/run/docker.sock:/s",
    "/:/host:ro",
    "/etc:/host",
    "~/.ssh:/keys",
    "../../:/up",
    "./data:/data",
    ".:/src",
    "..:/up",
    "$HOME/.ssh:/keys",
    "${PWD}:/work",
    "C:\\Windows:/host",
    "a/b:/data",
    "data :/data",
    "-data:/data",
  ])("refuses the host or ambiguous source in %s", (volume) => {
    expect(findHostMountVolumes([volume])).toEqual([volume]);
  });

  it("preserves named volumes, mount options and target-only app paths", () => {
    expect(
      findHostMountVolumes([
        "data:/data",
        " data:/data ",
        "pg-data:/pg:ro",
        "cache.v2:/cache:rw,nocopy",
        "openship-app-db_1:/data",
        "/data",
        "/data:ro",
        "storage",
        "storage/app",
      ]),
    ).toEqual([]);
  });
});
