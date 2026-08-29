import { describe, it, expect } from "vitest";
import { buildNetworkAliases } from "./docker";

describe("buildNetworkAliases — EndpointsConfig.Aliases for the project network", () => {
  it("returns just the primary when there are no extras", () => {
    expect(buildNetworkAliases("web")).toEqual(["web"]);
    expect(buildNetworkAliases("web", [])).toEqual(["web"]);
  });

  it("keeps the primary first, then the extras", () => {
    expect(buildNetworkAliases("postgres", ["db"])).toEqual(["postgres", "db"]);
  });

  it("drops an extra equal to the primary (no duplicate name)", () => {
    expect(buildNetworkAliases("db", ["db"])).toEqual(["db"]);
  });

  it("de-duplicates repeated extras, order-stable", () => {
    expect(buildNetworkAliases("api", ["db", "db", "cache"])).toEqual(["api", "db", "cache"]);
  });

  it("drops falsy entries so Docker never gets a dead alias", () => {
    expect(buildNetworkAliases("web", ["", "alias"])).toEqual(["web", "alias"]);
  });
});
