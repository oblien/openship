import { describe, expect, it } from "vitest";

import { STACKS } from "../src/stacks";
import { resolveStackVolumes } from "../src/volumes";

describe("rails stack definition", () => {
  it("persists storage/ — Rails 8 keeps SQLite AND Active Storage there", () => {
    expect(STACKS.rails.persistentPaths).toEqual(["storage"]);
  });

  it("mounts it the same way laravel's storage/ is mounted", () => {
    expect(resolveStackVolumes("rails")).toEqual(["storage:/app/storage"]);
    expect(resolveStackVolumes("rails")).toEqual(resolveStackVolumes("laravel"));
  });

  it("does NOT persist a directory that also holds code", () => {
    // Mounting over `db/` would shadow migrations a later release ships.
    for (const path of STACKS.rails.persistentPaths ?? []) {
      expect(["db", "app", "config", "lib", "bin"]).not.toContain(path);
    }
  });

  it("does not repeat `bundle install` — that is already the install step", () => {
    expect(STACKS.rails.defaultBuildCommand).not.toContain("bundle install");
  });

  it("precompiles with the dummy secret, as Rails' own Dockerfile does", () => {
    expect(STACKS.rails.defaultBuildCommand).toContain("SECRET_KEY_BASE_DUMMY=1");
    expect(STACKS.rails.defaultBuildCommand).toContain("assets:precompile");
  });

  it("precompiles in production, so the output is production assets", () => {
    expect(STACKS.rails.defaultBuildCommand).toContain("RAILS_ENV=production");
  });

  it("binds the injected $PORT rather than a hardcoded 3000", () => {
    expect(STACKS.rails.defaultStartCommand).toContain("PORT");
  });

  it("still declares a build step, so preflight keeps warning on a missing one", () => {
    expect(STACKS.rails.defaultBuildCommand.trim()).not.toBe("");
  });
});
