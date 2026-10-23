import { describe, expect, it } from "vitest";
import { parseInput } from "../src";
import { ProjectEdgeConfigSchema } from "../src/project-integrations";

describe("domain body-cap read-back contract", () => {
  it("preserves saved, effective and observed differences for SDK consumers", () => {
    const report = {
      reachable: true,
      saved: { clientMaxBodySize: "2m" },
      hosts: [
        {
          hostname: "events.example.com",
          found: true,
          tls: true,
          driftCount: 1,
          adoptable: {},
          directives: [],
          bodyLimit: {
            saved: { clientMaxBodySize: "1m" },
            effective: "1m",
            source: "domain",
            observed: "2m",
            configurationMatches: false,
          },
        },
      ],
    };
    expect(parseInput(ProjectEdgeConfigSchema, report)).toEqual(report);
    const inherited = {
      ...report,
      hosts: [
        {
          ...report.hosts[0]!,
          bodyLimit: {
            saved: null,
            effective: null,
            source: "edge",
            observed: null,
            configurationMatches: null,
          },
        },
      ],
    };
    expect(parseInput(ProjectEdgeConfigSchema, inherited).hosts[0]!.bodyLimit).toEqual(
      inherited.hosts[0]!.bodyLimit,
    );
  });
});
