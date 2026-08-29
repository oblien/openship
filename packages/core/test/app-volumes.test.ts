import { describe, expect, it } from "vitest";

import {
  APP_DIR,
  appVolumeTargets,
  normalizeAppVolume,
  normalizeAppVolumes,
  resolveProjectVolumes,
  resolveStackVolumes,
  volumeAutoName,
} from "../src/volumes";

describe("normalizeAppVolume", () => {
  it("expands a bare app-relative path into a named volume on the app dir", () => {
    expect(normalizeAppVolume("storage")).toBe(`storage:${APP_DIR}/storage`);
    expect(normalizeAppVolume("storage/app")).toBe(`storage-app:${APP_DIR}/storage/app`);
  });

  it("gives an absolute in-app path the SAME volume name as its relative form", () => {
    // Declaring `storage` and `/app/storage` must not create two volumes — one of
    // them would come up empty and the app would silently lose the other's data.
    expect(normalizeAppVolume("/app/storage")).toBe(normalizeAppVolume("storage"));
  });

  it("passes a full compose spec through untouched (named volume, bind mount, mode)", () => {
    expect(normalizeAppVolume("shared_uploads:/app/storage")).toBe("shared_uploads:/app/storage");
    expect(normalizeAppVolume("/srv/data:/app/storage")).toBe("/srv/data:/app/storage");
    expect(normalizeAppVolume("shared:/app/storage:ro")).toBe("shared:/app/storage:ro");
  });

  it("keeps the bind mode when expanding a bare path", () => {
    expect(normalizeAppVolume("storage:ro")).toBe(`storage:${APP_DIR}/storage:ro`);
  });

  it("mounts an out-of-app absolute path at itself", () => {
    expect(normalizeAppVolume("/var/lib/thing")).toBe("var-lib-thing:/var/lib/thing");
  });

  it("rejects entries that can't be a mount", () => {
    expect(normalizeAppVolume("")).toBeNull();
    expect(normalizeAppVolume("   ")).toBeNull();
    expect(normalizeAppVolume("./")).toBeNull();
  });
});

describe("volumeAutoName", () => {
  it("reduces a path to a docker-safe name", () => {
    expect(volumeAutoName("storage/framework/cache")).toBe("storage-framework-cache");
    expect(volumeAutoName("/data/")).toBe("data");
    expect(volumeAutoName("weird name!")).toBe("weird-name");
  });

  it("never returns empty", () => {
    expect(volumeAutoName("///")).toBe("data");
  });
});

describe("normalizeAppVolumes", () => {
  it("drops duplicate targets, whatever form they were declared in", () => {
    expect(normalizeAppVolumes(["storage", "/app/storage", "storage/app"])).toEqual([
      `storage:${APP_DIR}/storage`,
      `storage-app:${APP_DIR}/storage/app`,
    ]);
  });

  it("skips unusable entries instead of failing the list", () => {
    expect(normalizeAppVolumes(["", "storage"])).toEqual([`storage:${APP_DIR}/storage`]);
  });
});

describe("resolveStackVolumes", () => {
  it("gives Laravel its storage dir with no configuration", () => {
    expect(resolveStackVolumes("laravel")).toEqual([`storage:${APP_DIR}/storage`]);
  });

  it("does not persist Laravel's database dir (it holds migrations, not just the sqlite file)", () => {
    expect(resolveStackVolumes("laravel").some((v) => v.includes("/database"))).toBe(false);
  });

  it("returns nothing for stacks with no declared state, and for unknown ones", () => {
    expect(resolveStackVolumes("symfony")).toEqual([]);
    expect(resolveStackVolumes("nextjs")).toEqual([]);
    expect(resolveStackVolumes("not-a-stack")).toEqual([]);
    expect(resolveStackVolumes(null)).toEqual([]);
  });
});

describe("resolveProjectVolumes", () => {
  it("falls back to the stack default only when nothing is declared", () => {
    expect(resolveProjectVolumes(null, "laravel")).toEqual([`storage:${APP_DIR}/storage`]);
    expect(resolveProjectVolumes(undefined, "laravel")).toEqual([`storage:${APP_DIR}/storage`]);
  });

  it("treats an empty declaration as 'no volumes', not as 'use the default'", () => {
    expect(resolveProjectVolumes([], "laravel")).toEqual([]);
  });

  it("normalizes what the project declared", () => {
    expect(resolveProjectVolumes(["uploads"], "laravel")).toEqual([
      `uploads:${APP_DIR}/uploads`,
    ]);
  });
});

describe("appVolumeTargets", () => {
  it("returns app-relative targets for the bare runtime's shared dirs", () => {
    expect(appVolumeTargets([`storage:${APP_DIR}/storage`, "shared:/app/uploads:rw"])).toEqual([
      "storage",
      "uploads",
    ]);
  });

  it("ignores mounts outside the app dir (bare has nothing to symlink for those)", () => {
    expect(appVolumeTargets(["data:/var/lib/thing"])).toEqual([]);
  });
});
