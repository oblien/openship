import { describe, expect, it } from "vitest";
import { parseTraefikRule } from "./traefik-rules";

describe("Traefik HTTP rule preservation", () => {
  it("preserves nested host/path alternatives without crossing their conditions", () => {
    expect(
      parseTraefikRule(
        "(Host(`a.example.com`) && PathPrefix(`/api`)) || (Host(`b.example.com`) && Path(`/rpc`))",
      ),
    ).toEqual([
      { hosts: ["a.example.com"], path: "/api" },
      { hosts: ["b.example.com"], path: "/rpc", exact: true },
    ]);
  });
  it("intersects conditions rather than unioning contradictory matches", () => {
    expect(parseTraefikRule("Host(`a.example.com`) && Host(`b.example.com`)")).toEqual([]);
    expect(
      parseTraefikRule("Host(`a.example.com`) && PathPrefix(`/api`) && Path(`/api/v1`)"),
    ).toEqual([{ hosts: ["a.example.com"], path: "/api/v1", exact: true }]);
  });
  it.each([
    "!Host(`a.example.com`)",
    "Host(`a.example.com`) && Method(`POST`)",
    "HostRegexp(`.*`)",
    "Host(`a.example.com`) trailing",
    "(Host(`a.example.com`)",
    "Host(`a.example.com`) &&",
    "(".repeat(40) + "Host(`a.example.com`)" + ")".repeat(40),
  ])("refuses unsupported or malformed rules: %s", (rule) => {
    expect(parseTraefikRule(rule)).toBeNull();
  });
});
