import { describe, expect, it } from "vitest";

import { resolveDockerBuildArgs } from "./docker-build-args";

describe("resolveDockerBuildArgs (#689)", () => {
  it("#795 forwards project env to Dockerfile ARG without a duplicate service map", () => {
    expect(
      resolveDockerBuildArgs({
        envVars: {
          DATABASE_URI: "postgres://db/app",
          PAYLOAD_SECRET: "payload-secret",
          SERVER_URL: "https://admin.example.com",
          R4_SECRET_KEY: "r4-secret",
        },
      }),
    ).toEqual({
      DATABASE_URI: "postgres://db/app",
      PAYLOAD_SECRET: "payload-secret",
      SERVER_URL: "https://admin.example.com",
      R4_SECRET_KEY: "r4-secret",
      NODE_ENV: "production",
    });
  });

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
