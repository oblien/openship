import { describe, expect, it } from "vitest";
import { matchBackupSource } from "../src/backup/common/source-match";
import type { BackupSource } from "../src/backup/types";

/**
 * listSources labels the same volume two ways depending on which tier answered
 * (live container mounts → physical name; DB fallback → `${source}-${index}`),
 * so a restore has to reconcile a recorded id against today's labels. Wrong
 * answers here write an archive into the wrong volume, hence the refusals.
 */
const src = (id: string, source: string, target = "/data"): BackupSource => ({
  id,
  source,
  target,
  type: "volume",
});

describe("matchBackupSource", () => {
  it("prefers an exact id match", () => {
    const sources = [src("proj_data", "proj_data"), src("proj_data-0", "other")];
    expect(matchBackupSource(sources, "proj_data")?.source).toBe("proj_data");
  });

  it("matches a container-mount id against the DB fallback's suffixed id", () => {
    // Backup ran while the container was up (id = "proj_data"); restore runs
    // with it gone, so listSources produced "proj_data-0".
    const sources = [src("proj_data-0", "proj_data")];
    expect(matchBackupSource(sources, "proj_data")?.id).toBe("proj_data-0");
  });

  it("matches a suffixed recorded id against a live container mount", () => {
    const sources = [src("proj_data", "proj_data")];
    expect(matchBackupSource(sources, "proj_data-0")?.id).toBe("proj_data");
  });

  it("refuses when two sources share the physical volume", () => {
    // Same volume mounted at two paths: picking either would be a guess.
    const sources = [src("proj_data-0", "proj_data", "/a"), src("proj_data-1", "proj_data", "/b")];
    expect(matchBackupSource(sources, "proj_data")).toBeNull();
  });

  it("does not match a different volume that shares a numeric-suffix prefix", () => {
    const sources = [src("proj_logs", "proj_logs")];
    expect(matchBackupSource(sources, "proj_data-0")).toBeNull();
  });

  it("returns null for an empty target id or empty source list", () => {
    expect(matchBackupSource([src("proj_data", "proj_data")], "   ")).toBeNull();
    expect(matchBackupSource([], "proj_data")).toBeNull();
  });

  it("keeps a volume whose own name ends in a digit reachable by exact id", () => {
    // "pg-16" must not be reduced to "pg" — exact match runs first.
    const sources = [src("pg-16", "pg-16"), src("pg", "pg")];
    expect(matchBackupSource(sources, "pg-16")?.source).toBe("pg-16");
  });
});
