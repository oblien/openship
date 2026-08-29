import { describe, it, expect } from "vitest";
import { aliasConflictsWithSiblings } from "./service.service";

describe("aliasConflictsWithSiblings — reject an alias that shadows a sibling on the same network", () => {
  it("collides with a sibling's SERVICE NAME (normalized)", () => {
    expect(aliasConflictsWithSiblings("db", [{ name: "DB" }])).toBe(true);
    expect(aliasConflictsWithSiblings("my-db", [{ name: "My DB" }])).toBe(true);
  });

  it("collides with a sibling's custom ALIAS (normalized)", () => {
    expect(
      aliasConflictsWithSiblings("cache", [{ name: "redis", advanced: { alias: "Cache" } }]),
    ).toBe(true);
  });

  it("does not collide when name and alias differ", () => {
    expect(
      aliasConflictsWithSiblings("gateway", [
        { name: "web", advanced: { alias: "frontend" } },
        { name: "api" },
      ]),
    ).toBe(false);
  });

  it("ignores a sibling with no/empty advanced alias", () => {
    expect(aliasConflictsWithSiblings("x", [{ name: "web", advanced: null }])).toBe(false);
    expect(aliasConflictsWithSiblings("x", [{ name: "web", advanced: {} }])).toBe(false);
  });

  it("collides with the project's single-app internalAlias (normalized)", () => {
    expect(aliasConflictsWithSiblings("cache", [], "Cache")).toBe(true);
    expect(aliasConflictsWithSiblings("cache", [], "cache")).toBe(true);
  });

  it("does not collide when no internalAlias is given or it differs", () => {
    expect(aliasConflictsWithSiblings("cache", [], null)).toBe(false);
    expect(aliasConflictsWithSiblings("cache", [])).toBe(false);
    expect(aliasConflictsWithSiblings("cache", [], "edge")).toBe(false);
  });
});
