import { describe, expect, it } from "vitest";

import { compileCloudDockerfilePlan } from "./cloud";
import { resolveDockerBuildArgs } from "./docker-build-args";

describe("resolveDockerBuildArgs (#689)", () => {
  it("keeps compatibility defaults while explicit service args win", () => {
    expect(
      resolveDockerBuildArgs({
        envVars: { SHARED: "project", NODE_ENV: "preview", INVALID_KEY_DASH: "ok" },
        buildArgs: { SHARED: "service", NODE_ENV: "test", APP_PACKAGE: "@myorg/api" },
      }),
    ).toEqual({
      SHARED: "service",
      NODE_ENV: "test",
      INVALID_KEY_DASH: "ok",
      APP_PACKAGE: "@myorg/api",
    });
  });

  it("filters invalid legacy env names but rejects invalid explicit service args", () => {
    expect(
      resolveDockerBuildArgs({ envVars: { "LEGACY-BAD": "x", GOOD_KEY: "y" } }),
    ).toEqual({ NODE_ENV: "production", GOOD_KEY: "y" });
    expect(() =>
      resolveDockerBuildArgs({ envVars: {}, buildArgs: { "BAD-KEY": "x" } }),
    ).toThrow(/BAD-KEY/);
  });
});

describe("cloud Dockerfile build args (#689)", () => {
  it("applies the same explicit ARG override to the compiled workspace plan", () => {
    const plan = compileCloudDockerfilePlan(
      `ARG BASE=alpine\nFROM \${BASE}\nARG APP_PACKAGE=default\nRUN echo \${APP_PACKAGE}\n`,
      {
        envVars: { BASE: "busybox" },
        buildArgs: { BASE: "alpine:3.20", APP_PACKAGE: "@myorg/api" },
      },
    );

    expect(plan.globalArgs.BASE).toBe("alpine:3.20");
    // The plan deliberately keeps FROM symbolic; the cloud executor resolves
    // it from globalArgs when it selects the workspace base image.
    expect(plan.stages[0]?.baseImage).toBe("${BASE}");
    expect(plan.stages[0]?.args.APP_PACKAGE).toBe("@myorg/api");
    expect(JSON.stringify(plan.stages[0]?.steps)).toContain("@myorg/api");
  });
});
