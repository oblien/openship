import { describe, expect, it } from "vitest";
import { collectGrant } from "../../src/commands/token";

describe("--grant parsing", () => {
  it("keeps the colon inside a capability", () => {
    expect(collectGrant("project:proj_1:domains:read,domains:write,domains:delete", [])).toEqual([
      {
        resourceType: "project",
        resourceId: "proj_1",
        permissions: ["domains:read", "domains:write", "domains:delete"],
      },
    ]);
  });

  it("still parses coarse levels and rejects unknown permissions", () => {
    expect(collectGrant("project:proj_1:read,write", [])[0]!.permissions).toEqual([
      "read",
      "write",
    ]);
    expect(() => collectGrant("project:proj_1:domains:purge", [])).toThrow("Invalid permission");
    expect(() => collectGrant("project:proj_1", [])).toThrow("Expected type:id");
  });
});
