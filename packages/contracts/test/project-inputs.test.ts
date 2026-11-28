import { describe, expect, it } from "vitest";
import { CreateProjectBody, parseInput, UpdateProjectBody } from "../src";

// Regression test for https://github.com/oblien/openship/issues/1018:
// projects advertise "unlimited domains" but the project input schemas capped
// publicEndpoints (which carry each domain) at 20, so a 21st domain could not
// be added from the dashboard.
const endpoint = (i: number) => ({
  port: 443,
  customDomain: `d${i}.example.com`,
  domainType: "custom" as const,
});

describe("project publicEndpoints domain cap (issue #1018)", () => {
  it("accepts more than 20 public endpoints on project update", () => {
    const publicEndpoints = Array.from({ length: 21 }, (_, i) => endpoint(i));
    const parsed = parseInput(UpdateProjectBody, { publicEndpoints });
    expect(parsed.publicEndpoints).toHaveLength(21);
  });

  it("accepts more than 20 public endpoints on project create", () => {
    const publicEndpoints = Array.from({ length: 25 }, (_, i) => endpoint(i));
    const parsed = parseInput(CreateProjectBody, { name: "x", publicEndpoints });
    expect(parsed.publicEndpoints).toHaveLength(25);
  });

  it("still rejects malformed endpoints", () => {
    const publicEndpoints = [{ port: 99999, customDomain: "d1.example.com" }];
    expect(() => parseInput(UpdateProjectBody, { publicEndpoints })).toThrow();
  });
});

describe.each([CreateProjectBody, UpdateProjectBody])("static fallback input", (schema) => {
  it.each([true, false])("preserves %s instead of stripping the setting", (spaFallback) => {
    expect(
      parseInput(schema, { name: "site", routingConfig: { spaFallback } }).routingConfig,
    ).toEqual({ spaFallback });
  });
  it.each(["false", 0, null])("rejects a non-boolean setting: %s", (spaFallback) => {
    expect(() => parseInput(schema, { name: "site", routingConfig: { spaFallback } })).toThrow();
  });
});

describe.each([CreateProjectBody, UpdateProjectBody])(
  "runtimeInstallCommand input (#1773)",
  (schema) => {
    it("accepts string and null values", () => {
      const cmd = "apt-get update && apt-get install -y postgresql-client-16";
      expect(
        parseInput(schema, { name: "app", runtimeInstallCommand: cmd }).runtimeInstallCommand,
      ).toBe(cmd);
      expect(
        parseInput(schema, { name: "app", runtimeInstallCommand: null }).runtimeInstallCommand,
      ).toBeNull();
    });

    it("rejects strings exceeding max length", () => {
      const tooLong = "a".repeat(1001);
      expect(() => parseInput(schema, { name: "app", runtimeInstallCommand: tooLong })).toThrow();
    });
  },
);
