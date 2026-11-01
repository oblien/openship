import { describe, it, expect } from "vitest";
import { CHECKED_RESOURCE_TYPES } from "@repo/platform";
import { parsePermissionTag } from "../../src/lib/route-permission";

/**
 * The boot scanner (route-scanner.ts) promises to refuse startup on
 * "PermissionSpec tags that point at nonexistent resources". It delegates
 * that check to parsePermissionTag, so the parser must reject a tag whose
 * leaf resource is not a known resource type — otherwise a typo like
 * "project:servcie:write" boots fine and only blows up at request time.
 */
describe("parsePermissionTag leaf validation", () => {
  it.each(["servcie", "unknown", "constructor", "__proto__"])(
    "rejects the unknown leaf %s",
    (leaf) => {
      expect(() => parsePermissionTag(`project:${leaf}:write`)).toThrow(
        `Invalid resource "${leaf}"`,
      );
    },
  );

  it.each(CHECKED_RESOURCE_TYPES)("recognizes the shared checked-resource name %s", (leaf) => {
    expect(parsePermissionTag(`project:${leaf}:read`).leaf).toBe(leaf);
  });

  it("still accepts every valid nested tag shape", () => {
    expect(parsePermissionTag("project:service:write").leaf).toBe("service");
    expect(parsePermissionTag("project:deployment:list").leaf).toBe("deployment");
    expect(parsePermissionTag("backup_destination:backup_run:read").leaf).toBe("backup_run");
    expect(parsePermissionTag("project:env_var:read").leaf).toBe("env_var");
    expect(parsePermissionTag("project:build_session:read").leaf).toBe("build_session");
  });

  it("still accepts simple tags where the leaf is the root", () => {
    const parsed = parsePermissionTag("project:read");
    expect(parsed.leaf).toBe("project");
    expect(parsed.root).toBe("project");
  });

  it("still rejects invalid actions and roots as before", () => {
    expect(() => parsePermissionTag("project:service:edit")).toThrow(/Invalid action/);
    expect(() => parsePermissionTag("projec:service:write")).toThrow(/Invalid root resource/);
  });
});
