import { describe, expect, it } from "vitest";
import { toggleMigrationService, validMigrationServiceScope } from "./service-scope";

describe("migration selection from topology", () => {
  it("keeps deselecting the last service empty instead of copying the entire project", () => {
    const scope = toggleMigrationService(new Set(["api"]), "api", ["api", "db", "worker"]);
    expect(scope).toEqual(new Set());
    expect(validMigrationServiceScope(scope, ["api", "db", "worker"])).toBe(false);
  });
  it("starts narrowing all services by subtracting the clicked row", () => {
    expect(toggleMigrationService(null, "db", ["api", "db", "worker"])).toEqual(
      new Set(["api", "worker"]),
    );
  });
  it("preserves an explicit selection when more services appear", () => {
    const scope = toggleMigrationService(new Set(["api"]), "db", ["api", "db"]);
    expect(scope).toEqual(new Set(["api", "db"]));
    expect(scope?.has("worker")).toBe(false);
  });
  it("refuses stale or not-yet-loaded service selections", () => {
    expect(validMigrationServiceScope(new Set(["api"]), null)).toBe(false);
    expect(validMigrationServiceScope(new Set(["removed"]), ["api"])).toBe(false);
    expect(validMigrationServiceScope(new Set(["api"]), ["api", "db"])).toBe(true);
    expect(validMigrationServiceScope(null, [])).toBe(true);
  });
});
